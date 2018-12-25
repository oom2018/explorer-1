/*
Name: Ethereum Blockchain syncer
Version: .0.0.2
This file will start syncing the blockchain from the node address you provide in the conf.json file.
Please read the README in the root directory that explains the parameters of this code
*/
require( '../db.js' );
var wonUnits = require("../lib/wonUnits.js");
var BigNumber = require('bignumber.js');
var getSigner = require("../lib/blockMiner.js");

var fs = require('fs');
var Web3 = require('../lib/won-web3');

var mongoose        = require( 'mongoose' );
var Block           = mongoose.model( 'Block' );
var Transaction     = mongoose.model( 'Transaction' );
var TransferToken     = mongoose.model( 'TransferToken' );

const updateTokens = require("./updateTokens");

const syncInterval = process.env.SYNC_INTERVAL || 1000;

/**
  //Just listen for latest blocks and sync from the start of the app.
**/
var listenBlocks = function(config) {
    if(web3.isConnected()) {
        var newBlocks = web3.won.filter("latest");
        newBlocks.watch(function (error, latestBlock) {
            if (error) {
                console.log('Block Filter Callback ' + error);
                if (error.message.includes('filter not found')) {
                    newBlocks.stopWatching();
                    setTimeout(function () { listenBlocks(config); }, syncInterval);
                }
            } else if (latestBlock == null) {
                console.log('Warning: null block hash');
            } else {
                console.log('Found new block: ' + latestBlock);
                if (web3.isConnected()) {
                    web3.won.getBlock(latestBlock, true, function (error, blockData) {
                        if (error) {
                            console.log('Warning: error on getting block with hash/number: ' + latestBlock + ': ' + error);
                        } else if (blockData == null) {
                            console.log('Warning: null block data received from the block with hash/number: ' + latestBlock);
                        } else {
                            writeBlockToDB(config, blockData, true);
                            writeTransactionsToDB(config, blockData, true);
                        }
                    });
                } else {
                    console.log('Error: Web3 connection time out trying to get block ' + latestBlock + ' retrying connection now');
                    setTimeout(function () { listenBlocks(config); }, syncInterval);
                }
            }
        });
    } else {
        console.log('Error: Web3 is not connected, retrying block watching shortly...');
        setTimeout(function () { listenBlocks(config); }, syncInterval*2);
    }
};
/**
  If full sync is checked this function will start syncing the block chain from lastSynced param see README
**/
var syncChain = function(config, nextBlock){
  if(web3.isConnected()) {
    if (typeof nextBlock === 'undefined') {
      prepareSync(config, function(error, startBlock) {
        if(error) {
          console.log('ERROR: error: ' + error);
          return;
        }
        syncChain(config, startBlock);
      });
      return;
    }

    if( nextBlock == null ) {
      console.log('nextBlock is null');
      return;
    } else if( nextBlock < config.startBlock ) {
      writeBlockToDB(config, null, true);
      writeTransactionsToDB(config, null, true);
      console.log('*** Sync Finsihed ***');
      config.syncAll = false;
      return;
    }

    var count = config.bulkSize;
    while(nextBlock >= config.startBlock && count > 0) {
      web3.won.getBlock(nextBlock, true, function(error,blockData) {
        if(error) {
          console.log('Warning: error on getting block with hash/number: ' + nextBlock + ': ' + error);
        }else if(blockData == null) {
          console.log('Warning: null block data received from the block with hash/number: ' + nextBlock);
        }else{
          writeBlockToDB(config, blockData);
          writeTransactionsToDB(config, blockData);
        }
      });
      nextBlock--;
      count--;
    }

    setTimeout(function() { syncChain(config, nextBlock); }, syncInterval);
  }else{
    console.log('Error: Web3 connection time out trying to get block ' + nextBlock + ' retrying connection now');
    // syncChain(config, nextBlock);
    setTimeout(function() { syncChain(config, nextBlock); }, syncInterval*2);
  }
}
/**
  Write the whole block object to DB
**/
var writeBlockToDB = function(config, blockData, flush) {
  var self = writeBlockToDB;
  if (!self.bulkOps) {
    self.bulkOps = [];
  }
  if (blockData && blockData.number >= 0) {
    blockData.miner = getSigner(blockData);
    self.bulkOps.push(new Block(blockData));
    console.log('\t- block #' + blockData.number.toString() + ' inserted.');
  }

  if(flush && self.bulkOps.length > 0 || self.bulkOps.length >= config.bulkSize) {
    var bulk = self.bulkOps;
    self.bulkOps = [];
    if(bulk.length == 0) return;

    Block.collection.insert(bulk, function( err, blocks ){
      if ( typeof err !== 'undefined' && err ) {
        if (err.code == 11000) {
          if(!('quiet' in config && config.quiet === true)) {
            console.log('Skip: Duplicate DB key : ' +err);
          }
        }else{
          console.log('Error: Aborted due to error on DB: ' + err);
          process.exit(9);
        }
      }else{
        console.log('* ' + blocks.insertedCount + ' blocks successfully written.');
      }
    });
  }
}
/**
  Break transactions out of blocks and write to DB
**/
var writeTransactionsToDB = function(config, blockData, flush) {
  var self = writeTransactionsToDB;
  if (!self.bulkOps) {
    self.bulkOps = [];
    self.transfers = [];
    self.blocks = 0;
  }
  if (blockData && blockData.transactions.length > 0) {
    for (d in blockData.transactions) {
      var txData = blockData.transactions[d];
      txData.timestamp = blockData.timestamp;
      txData.value = wonUnits.toWon(new BigNumber(txData.value), 'wei');
      self.bulkOps.push(txData);

      // parsing the input data if configured
      if (txData.to && txData.input !== "0x") {
        updateTokens.abiInfo(txData.to);

        var obj = updateTokens.decodeByAbi(txData.input);
        if (obj && obj.name === "transfer") {
          var conTx = {
            "txHash": txData.hash,
            "blockNumber": txData.blockNumber,
            "address": txData.to,
            "amount": obj.params[1].value,
            "from": txData.from,
            "to": obj.params[0].value,
            "gas": txData.gas,
            "timestamp": txData.timestamp
          };
          self.transfers.push(conTx);
        }

      }
    }
    console.log('\t- block #' + blockData.number.toString() + ': ' + blockData.transactions.length.toString() + ' transactions recorded.');
  }
  self.blocks++;

  if (flush && self.blocks > 0 || self.blocks >= config.bulkSize) {
    var bulk = self.bulkOps;
    self.bulkOps = [];
    self.blocks = 0;
    if(bulk.length == 0) return;

    Transaction.collection.insert(bulk, function( err, tx ){
      if ( typeof err !== 'undefined' && err ) {
        if (err.code == 11000) {
          if(!('quiet' in config && config.quiet === true)) {
            console.log('Skip: Duplicate transaction key ' + err);
          }
        }else{
          console.log('Error: Aborted due to error on Transaction: ' + err);
          process.exit(9);
        }
      }else{
        console.log('* ' + tx.insertedCount + ' transactions successfully recorded.');
      }
    });

    if (self.transfers.length === 0) return;
    var conTxs = self.transfers;
    self.transfers = [];
    TransferToken.collection.insert(conTxs, function (err, tx) {
        if ( typeof err !== 'undefined' && err ) {
            console.log('Error: Aborted due to error on Transfer: ' + err);
        }else{
            console.log('** ' + tx.insertedCount + ' transfer successfully recorded.');
        }
    });
  }
};
/**
  //check oldest block or starting block then callback
**/
var prepareSync = function(config, callback) {
  var blockNumber = null;
  var oldBlockFind = Block.find({}, "number").lean(true).sort('number').limit(1);
  oldBlockFind.exec(function (err, docs) {
    if(err || !docs || docs.length < 1) {
      // not found in db. sync from config.endBlock or 'latest'
      if(web3.isConnected()) {
        var currentBlock = web3.won.blockNumber;
        var latestBlock = config.endBlock || currentBlock || 'latest';
        if(latestBlock === 'latest') {
          web3.won.getBlock(latestBlock, true, function(error, blockData) {
            if(error) {
              console.log('Warning: error on getting block with hash/number: ' +   latestBlock + ': ' + error);
            } else if(blockData == null) {
              console.log('Warning: null block data received from the block with hash/number: ' + latestBlock);
            } else {
              console.log('Starting block number = ' + blockData.number);
              blockNumber = blockData.number - 1;
              callback(null, blockNumber);
            }
          });
        } else {
          console.log('Starting block number = ' + latestBlock);
          blockNumber = latestBlock - 1;
          callback(null, blockNumber);
        }
      } else {
        console.log('Error: Web3 connection error');
        callback(err, null);
      }
    }else{
      blockNumber = docs[0].number - 1;
      console.log('Old block found. Starting block number = ' + blockNumber);
      callback(null, blockNumber);
    }
  });
}
/**
  Block Patcher(experimental)
**/
var runPatcher = function(config, startBlock, endBlock) {
  if(!web3 || !web3.isConnected()) {
    console.log('Error: Web3 is not connected. Retrying connection shortly...');
    setTimeout(function() { runPatcher(config); }, 3000);
    return;
  }

  if(typeof startBlock === 'undefined' || typeof endBlock === 'undefined') {
    // get the last saved block
    var blockFind = Block.find({}, "number").lean(true).sort('-number').limit(1);
    blockFind.exec(function (err, docs) {
      if(err || !docs || docs.length < 1) {
        // no blocks found. terminate runPatcher()
        console.log('No need to patch blocks.');
        return;
      }

      var lastMissingBlock = docs[0].number + 1;

      try {
          var currentBlock = web3.won.blockNumber;
          runPatcher(config, lastMissingBlock, currentBlock - 1);
      } catch (e) {
          console.error(e);
      }
    });
    return;
  }

  var missingBlocks = endBlock - startBlock + 1;
  if (missingBlocks > 0) {
    console.log('Patching from #' + startBlock + ' to #' + endBlock);
    var patchBlock = startBlock;
    var count = 0;
    while(count < config.patchBlocks && patchBlock <= endBlock) {
      if(!('quiet' in config && config.quiet === true)) {
        console.log('Patching Block: ' + patchBlock)
      }
      web3.won.getBlock(patchBlock, true, function(error, patchData) {
        if(error) {
          console.log('Warning: error on getting block with hash/number: ' + patchBlock + ': ' + error);
        } else if(patchData == null) {
          console.log('Warning: null block data received from the block with hash/number: ' + patchBlock);
        } else {
          checkBlockDBExistsThenWrite(config, patchData)
        }
      });
      patchBlock++;
      count++;
    }
    // flush
    writeBlockToDB(config, null, true);
    writeTransactionsToDB(config, null, true);

    setTimeout(function() { runPatcher(config, patchBlock, endBlock); }, 1000);
  } else {
    // flush
    writeBlockToDB(config, null, true);
    writeTransactionsToDB(config, null, true);

    console.log('*** Block Patching Completed ***');
  }
}
/**
  This will be used for the patcher(experimental)
**/
var checkBlockDBExistsThenWrite = function(config, patchData, flush) {
  Block.find({number: patchData.number}, function (err, b) {
    if (!b.length){
      writeBlockToDB(config, patchData, flush);
      writeTransactionsToDB(config, patchData, flush);
    }else if(!('quiet' in config && config.quiet === true)) {
      console.log('Block number: ' +patchData.number.toString() + ' already exists in DB.');
    }
  });
};
/**
  Start config for node connection and sync
**/
var config = {};
//Look for config.json file if not
try {
    var configContents = fs.readFileSync('config.json');
    config = JSON.parse(configContents);
    console.log('config.json found.');
}
catch (error) {
  if (error.code === 'ENOENT') {
      console.log('No config file found.');
  }
  else {
      throw error;
      process.exit(1);
  }
}
// set the default NODE address to localhost if it's not provided
if (!('nodeAddr' in config) || !(config.nodeAddr)) {
  config.nodeAddr = 'http://localhost:8545'; // default
}
// set the default output directory if it's not provided
if (!('output' in config) || (typeof config.output) !== 'string') {
  config.output = '.'; // default this directory
}
// set the default size of array in block to use bulk operation.
if (!('bulkSize' in config) || (typeof config.bulkSize) !== 'number') {
  config.bulkSize = 100;
}
console.log('Connecting ' + (process.env.NODE_ADDR || config.nodeAddr) + '...');

// Sets address for RPC WEB3 to connect to, usually your node IP address defaults ot localhost
var web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ADDR || config.nodeAddr));

// patch missing blocks
if (config.patch === true){
  console.log('Checking for missing blocks');
  runPatcher(config);
}

// first call at start
updateTokens.webConfigInit();

// Start listening for latest blocks
listenBlocks(config);

// Starts full sync when set to true in config
if (config.syncAll === true){
  console.log('Starting Full Sync');
  syncChain(config);
}
