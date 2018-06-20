import config from '../config';
import { Schema, Document, model, DocumentQuery } from "mongoose";
import { CoinModel, ICoinModel } from "./coin";
import { WalletAddressModel } from "./walletAddress";
import { partition } from "../utils/partition";
import { ObjectID, ObjectId } from "bson";
import { TransformOptions } from "../types/TransformOptions";
import { ChainNetwork } from "../types/ChainNetwork";
import { TransformableModel } from "../types/TransformableModel";
import logger from "../logger";
import { LoggifyObject } from "../decorators/Loggify";
import { Bitcoin } from "../types/namespaces/Bitcoin";
import { CoreTransaction, ChainInfo } from "../types/namespaces/ChainAdapter";

export interface ITransaction {
  txid: string;
  chain: string;
  network: string;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: Date;
  blockTimeNormalized?: Date;
  coinbase: boolean;
  fee: number;
  size: number;
  locktime: number;
  outputs: {
    address: string;
  }[];
  wallets: ObjectID[];
}
export type TransactionQuery = {[key in keyof ITransaction]?: any}&
  Partial<DocumentQuery<ITransaction, Document>>;

type ITransactionDoc = ITransaction & Document;
type ITransactionModelDoc = ITransactionDoc & TransformableModel<ITransactionDoc>;

export type BatchImportMethodParams = {
  txs: Array<Bitcoin.Transaction>;
  height: number;
  blockTime?: Date;
  blockHash?: string;
  blockTimeNormalized?: Date;
  parentChain?: string;
  forkHeight?: number;
} & ChainNetwork;

export interface ITransactionModel extends ITransactionModelDoc {
  getTransactions: (params: { query: TransactionQuery }) => any;
  batchImport: (txs: CoreTransaction[], blockInfo?: {
    blockHash: string;
    blockTime: number;
    blockTimeNormalized: number;
    height: number;
  }) => Promise<void>;
  getMintOps: (txs: CoreTransaction[], height: number) => Promise<any[]>;
  getSpendOps: (txs: CoreTransaction[], height: number) => any[];
  addTransactions: (txs: CoreTransaction[], blockInfo?: {
    blockHash: string;
    blockTime: number;
    blockTimeNormalized: number;
    height: number;
  }) => Promise<any[]>;
}

const TransactionSchema = new Schema({
  txid: String,
  chain: String,
  network: String,
  blockHeight: Number,
  blockHash: String,
  blockTime: Date,
  blockTimeNormalized: Date,
  coinbase: Boolean,
  fee: Number,
  size: Number,
  locktime: Number,
  outputs: [{
    address: String,
  }],
  wallets: { type: [Schema.Types.ObjectId] }
});

TransactionSchema.index({ txid: 1 });
TransactionSchema.index({ chain: 1, network: 1, blockHeight: 1 });
TransactionSchema.index({ blockHash: 1 });
TransactionSchema.index({ chain: 1, network: 1, blockTimeNormalized: 1 });
TransactionSchema.index({ wallets: 1 }, { sparse: true });

// TODO: blockHash, blockHeight, blockTimeNormalized, wallets indices are all used
// might be able to get away with just indexing wallets

TransactionSchema.statics.batchImport = async (txs: CoreTransaction[], blockInfo?: {
  blockHash: string;
  blockTime: number;
  blockTimeNormalized: number;
  height: number;
}) => {
  const batch = (items, n, f) => Promise.all(partition(items, n).map(f));
  const height = (blockInfo && blockInfo.height) || -1;

  const mintOps = await TransactionModel.getMintOps(txs, height);
  logger.debug('Minting Coins', mintOps.length);
  await batch(mintOps, 10, b => CoinModel.collection.bulkWrite(b, {
    ordered: false
  }));

  const spendOps = TransactionModel.getSpendOps(txs, height);
  logger.debug('Spending Coins', spendOps.length);
  await batch(spendOps, 10, b => CoinModel.collection.bulkWrite(b, {
    ordered: false
  }));

  const txOps = await TransactionModel.addTransactions(txs, blockInfo);
  logger.debug('Writing Transactions', txOps.length);
  await batch(txOps, 10, b => TransactionModel.collection.bulkWrite(b, {
    ordered: false
  }));
};

TransactionSchema.statics.addTransactions = async (
  txs: CoreTransaction[],
  blockInfo?: {
    blockHash: string;
    blockTime: number;
    blockTimeNormalized: number;
    height: number;
  }
): Promise<any[]> => {
  const { chain, network } = txs[0];

  const mint = txs.map(tx => {
    return {
      txid: tx.hash,
      outputs: tx.outputs.map(out => {
        return {
          address: out.address,
        };
      }),
    };
  });

  const spent = await TransactionModel.find({
    txid: {
      $in: [].concat.apply([], txs.map(tx => {
        return tx.inputs.map(input => input.prevTxId);
      })),
    },
  }, {
    txid: 1,
    outputs: 1,
  });

  const addressToTxs: {
    [address: string]: Set<string>;
  } = mint.concat(spent).reduce((memo, tx) => {
    for (const output of tx.outputs) {
      if (!memo[output.address]) {
        memo[output.address] = new Set();
      }
      memo[output.address].add(tx.txid);
    }
    return memo;
  }, {});

  const wallets = await WalletAddressModel.find({
    address: {
      $in: Object.keys(addressToTxs),
    },
  }, {
    wallet: 1,
    address: 1,
  });

  const txToWallet: {
    [txid: string]: Set<ObjectId>;
  } = wallets.reduce((memo, wallet) => {
    const txs = addressToTxs[wallet.address];
    for (const txid of txs) {
      if (!memo[txid]) {
        memo[txid] = new Set();
      }
      memo[txid].add(wallet.wallet);
    }
    return memo;
  }, {});

  return txs.map(tx => {
    return {
      insertOne: {
        document: {
          txid: tx.hash,
          chain,
          network,
          blockHeight: blockInfo? blockInfo.height : -1,
          blockHash: blockInfo? blockInfo.blockHash : undefined,
          blockTime: blockInfo? blockInfo.blockTime : new Date(),
          blockTimeNormalized: blockInfo? blockInfo.blockTimeNormalized : new Date(),
          coinbase: tx.coinbase,
          size: tx.size,
          locktime: tx.nLockTime,
          outputs: tx.outputs.map(out => out.address),
          wallets: Array.from(txToWallet[tx.hash] || []),
        },
      },
    };
  });
};

TransactionSchema.statics.getMintOps = async (
  txs: CoreTransaction[],
  height: number,
): Promise<any[]> => {
  const info: ChainInfo = txs[0];
  const mintOps: any[] = [];
  let parentChainCoins = [];

  // TODO: figure out parent chain cross-db
  if (info.parent && info.parent.height && height < info.parent.height) {
    parentChainCoins = await CoinModel.find({
      chain: info.parent.chain,
      network: info.network,
      mintHeight: height,
      // TODO: getting parent unspent coins uses CoinModel.spentHeight index
      spentHeight: { $gt: -2, $lt: info.parent.height }
    }).lean();
  }

  for (const tx of txs) {
    for (const [index, output] of tx.outputs.entries()) {
      if (parentChainCoins.find((parentChainCoin: ICoinModel) =>
                                parentChainCoin.mintTxid === tx.hash &&
                                parentChainCoin.mintIndex === index)) {
        continue;
      }

      mintOps.push({
        updateOne: {
          filter: {
            id: `${tx.hash}.${index}`,
          },
          update: {
            $set: {
              id: `${tx.hash}.${index}`,
              mintTxid: tx.hash,
              mintIndex: index,
              chain: info.chain,
              network: info.network,
              mintHeight: height,
              coinbase: tx.coinbase,
              value: output.value,
              address: output.address,
              script: output.script,
              wallets: [],
            },
          },
          upsert: true,
          forceServerObjectId: true,
        },
      });
    }
  }

  const mintOpsAddresses = mintOps.map(
    mintOp => mintOp.updateOne.update.$set.address
  );

  const wallets = await WalletAddressModel.collection.find({
    address: { $in: mintOpsAddresses },
    // TODO: update wallets db
    chain: info.chain,
    network: info.network
  }, {
    batchSize: 10
  }).toArray();

  if (wallets.length > 0) {
    return mintOps.map(mintOp => {
      const matchingAddrs= wallets
        .filter(w => w.address === mintOp.updateOne.update.$set.address);
      mintOp.updateOne.update.$set.wallets = matchingAddrs.map(w => w.wallet);
      return mintOp;
    });
  }
  return mintOps;
}

TransactionSchema.statics.getSpendOps = (
  txs: CoreTransaction[],
  height: number,
): any[] => {
  const info: ChainInfo = txs[0];
  if (info.parent && info.parent.height && height < info.parent.height) {
    return [];
  }

  const spendOps: any[] = [];
  for (const tx of txs.filter(tx => !tx.coinbase)) {
    for (const input of tx.inputs) {
      const updateQuery: any = {
        updateOne: {
          filter: {
            id: `${input.prevTxId}.${input.outputIndex}`,
          },
          update: {
            $set: {
              mintTxid: input.prevTxId,
              mintIndex: input.outputIndex,
              spentTxid: tx.hash,
              spentHeight: height,
              spent: true,
            },
          },
          upsert: true,
          forceServerObjectId: true,
        },
      };
      if (config.pruneSpentScripts && height > 0) {
        updateQuery.updateOne.update.$unset = {
          script: null,
        };
      }
      spendOps.push(updateQuery);
    }
  }
  return spendOps;
};

TransactionSchema.statics.getTransactions = function(params: {
  query: TransactionQuery;
}) {
  let query = params.query;
  return TransactionModel.collection.aggregate([
    { $match: query },
    {
      $lookup: {
        from: "coins",
        localField: "txid",
        foreignField: "spentTxid",
        as: "inputs"
      }
    },
    {
      $lookup: {
        from: "coins",
        localField: "txid",
        foreignField: "mintTxid",
        as: "outputs"
      }
    }
  ]);
};

TransactionSchema.statics._apiTransform = function(
  tx: ITransactionModel,
  options: TransformOptions
) {
  let transform = {
    txid: tx.txid,
    network: tx.network,
    blockHeight: tx.blockHeight,
    blockHash: tx.blockHash,
    blockTime: tx.blockTime,
    blockTimeNormalized: tx.blockTimeNormalized,
    coinbase: tx.coinbase,
    fee: tx.fee
  };
  if (options && options.object) {
    return transform;
  }
  return JSON.stringify(transform);
};

LoggifyObject(TransactionSchema.statics, 'TransactionSchema');
export let TransactionModel: ITransactionModel = model<
  ITransactionDoc,
  ITransactionModel
  >("Transaction", TransactionSchema);
