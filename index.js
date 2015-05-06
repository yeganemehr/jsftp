/* vim:set ts=2 sw=2 sts=2 expandtab */
/*global require: true module: true */
/*
 * @package jsftp
 * @copyright Copyright(c) 2012 Ajax.org B.V. <info@c9.io>
 * @author Sergi Mansilla <sergi.mansilla@gmail.com>
 * @license https://github.com/sergi/jsFTP/blob/master/LICENSE MIT License
 */

'use strict';

var Net = require('net');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var fs = require('fs');

var debug = require('debug')('jsftp:general');
var dbgCommand = require('debug')('jsftp:command');
var dbgResponse = require('debug')('jsftp:response');

var Rx = require('rx');
var RxNode = require('rx-node');
var es = require('event-stream');
var ResponseParser = require('ftp-response-parser');
var ListingParser = require('parse-listing');
var utf8 = require('utf8');
var once = require('once');

var COMMANDS = [
// Commands without parameters
'abor', 'pwd', 'cdup', 'feat', 'noop', 'quit', 'pasv', 'syst',
// Commands with one or more parameters
'cwd', 'dele', 'list', 'mdtm', 'mkd', 'mode', 'nlst', 'pass', 'retr', 'rmd', 'rnfr', 'rnto', 'site', 'stat', 'stor', 'type', 'user', 'xrmd', 'opts',
// Extended features
'chmod', 'size'];

var FTP_PORT = 21;
var TIMEOUT = 10 * 60 * 1000;
var IDLE_TIME = 30000;
var NOOP = function NOOP() {};

var expectedMarks = {
  marks: [125, 150],
  ignore: 226
};

// Regular Expressions
var RE_PASV = /([-\d]+,[-\d]+,[-\d]+,[-\d]+),([-\d]+),([-\d]+)/;
var FTP_NEWLINE = /\r\n|\n/;

function getPasvPort(text, callback) {
  var match = RE_PASV.exec(text);
  if (!match) {
    return callback(new Error('Bad passive host/port combination'));
  }

  callback(null, {
    host: match[1].replace(/,/g, '.'),
    port: (parseInt(match[2], 10) & 255) * 256 + (parseInt(match[3], 10) & 255)
  });
}

function runCmd(cmd) {
  for (var _len = arguments.length, args = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
    args[_key - 1] = arguments[_key];
  }

  var callback = NOOP;

  if (typeof args[args.length - 1] === 'function') {
    callback = args.pop();
  }

  this.execute(cmd + ' ' + args.join(' '), callback);
}

var Ftp = module.exports = function (cfg) {
  var _this = this;

  var _arguments = arguments;

  EventEmitter.call(this);

  // True if the server doesn't support the `stat` command. Since listing a
  // directory or retrieving file properties is quite a common operation, it is
  // more efficient to avoid the round-trip to the server.
  this.useList = false;
  this.user = cfg.user || 'anonymous';
  this.pass = cfg.pass || '@anonymous';
  this.port = cfg.port || FTP_PORT;
  this.host = cfg.host;

  this.commandQueue = [];

  // Generate generic methods from parameter names. they can easily be
  // overriden if we need special behavior. they accept any parameters given,
  // it is the responsability of the user to validate the parameters.
  this.raw = function () {
    return runCmd.apply(_this, _arguments);
  };
  COMMANDS.forEach(function (cmd) {
    return _this.raw[cmd] = runCmd.bind(_this, cmd);
  });

  /** this.raw mechanism build with proxies
    let cmdHandler = {
  get: function(receiver, cmd) {
  if (typeof cmd === 'string') {
  return runCmd.bind(self, cmd);
  }
  }
  }
  this.raw = new Proxy({}, cmdHandler);
  */

  this._createSocket(this.port, this.host);
};

util.inherits(Ftp, EventEmitter);

Ftp.prototype._createSocket = function (port, host) {
  var _this2 = this;

  var firstAction = arguments[2] === undefined ? NOOP : arguments[2];

  if (this.socket && this.socket.destroy) {
    this.socket.destroy();
  }

  if (this.resParser) {
    this.resParser.end();
  }
  this.resParser = new ResponseParser();

  this.authenticated = false;
  this.socket = Net.createConnection(port, host, firstAction);
  this.socket.on('connect', function () {
    return _this2.emit('connect');
  });
  this.socket.on('timeout', this.emit);
  this.socket.on('close', function (err) {
    if (err) {
      _this2.emit('error', err);
    }
    _this2.authenticated = false;
  });

  this.pipeline = es.pipeline(this.socket, this.resParser);

  this.pipeline.on('data', function (data) {
    _this2.emit('data', data);
    dbgResponse(data.text);
  });
  this.pipeline.on('error', function (err) {
    return _this2.emit('error', err);
  });

  if (this.cmdSubject$) {
    this.cmdSubject$.dispose();
  }

  this.cmdSubject$ = new Rx.Subject();

  var firstCmd$ = this.cmdSubject$.take(1);
  var restCmd$ = this.cmdSubject$.skip(1);

  //firstCmd$.subscribe(v=>console.log('F',v))
  //restCmd$.subscribe(v=>console.log('R', v))

  var validResponses$ = RxNode.fromStream(this.pipeline).filter(function (res) {
    return [220].indexOf(res.code) === -1;
  });

  validResponses$.subscribe(function (v) {
    return console.log('V', v);
  });

  this.cmdResponsePair$ = Rx.Observable.zip(Rx.Observable.merge(firstCmd$, restCmd$), validResponses$, function (cmd, res) {
    return [cmd, res];
  }).subscribe(function (pair) {
    //console.log(pair);
    _this2.parse(pair[1], pair[0]);
  });
};

//Ftp.prototype.parseResponse = function(response) {
////if (this.commandQueue.length === 0) return;
//if ([220].indexOf(response.code) > -1) return;

//var next = this.commandQueue[0].callback;
//if (response.isMark) {
//// If we receive a Mark and it is not expected, we ignore that command
//if (!next.expectsMark ||
//next.expectsMark.marks.indexOf(response.code) === -1) {
//return;
//}

//// We might have to ignore the command that comes after the mark.
//if (next.expectsMark.ignore) {
//this.ignoreCmdCode = next.expectsMark.ignore;
//}
//}

//if (this.ignoreCmdCode === response.code) {
//this.ignoreCmdCode = null;
//return;
//}

//this.parse(response, this.commandQueue.shift());
//};

Ftp.prototype.nextCmd = function (cmd) {
  this.cmdSubject$.onNext(cmd);
  dbgCommand(cmd);
  this.pipeline.write(cmd.action + '\r\n');
};

/**
 * Check whether the ftp user is authenticated at the moment of the
 * enqueing. ideally this should happen in the `push` method, just
 * before writing to the socket, but that would be complicated,
 * since we would have to 'unshift' the auth chain into the queue
 * or play the raw auth commands (that is, without enqueuing in
 * order to not mess up the queue order. ideally, that would be
 * built into the queue object. all this explanation to justify a
 * slight slopiness in the code flow.
 *
 * @param {string} action
 * @param {function} callback
 */
Ftp.prototype.execute = function (action) {
  var _this3 = this;

  var callback = arguments[1] === undefined ? NOOP : arguments[1];

  if (this.socket && this.socket.writable) {
    return this.runCommand(action, callback);
  }

  this.authenticated = false;
  this._createSocket(this.port, this.host, function () {
    _this3.runCommand(action.trim(), callback);
  });
};

Ftp.prototype.runCommand = function (action, callback) {
  var _this4 = this;

  var cmd = { action: action, callback: callback };

  if (this.authenticated || /feat|syst|user|pass/.test(action)) {
    this.nextCmd(cmd);
    return;
  }

  this.getFeatures(function () {
    _this4.auth(_this4.user, _this4.pass, function () {
      _this4.nextCmd(cmd);
    });
  });
};

/**
 * Parse is called each time that a comand and a request are paired
 * together. That is, each time that there is a round trip of actions
 * between the client and the server.
 *
 * @param {Object} response Response from the server (contains text and code)
 * @param {Array} command Contains the command executed and a callback (if any)
 */
Ftp.prototype.parse = function (response, command) {
  var err = null;
  if (response.isError) {
    err = new Error(response.text || 'Unknown FTP error.');
    err.code = response.code;
  }

  command.callback(err, response);
};

/**
 * Returns true if the current server has the requested feature.
 *
 * @param {String} feature Feature to look for
 * @return {Boolean} Whether the current server has the feature
 */
Ftp.prototype.hasFeat = function (feature) {
  return !!feature && this.features.indexOf(feature.toLowerCase()) > -1;
};

/**
 * Returns an array of features supported by the current FTP server
 *
 * @param {String} features Server response for the 'FEAT' command
 * @return {String[]} Array of feature names
 */
Ftp.prototype._parseFeats = function (features) {
  // Split and ignore header and footer
  var featureLines = features.split(FTP_NEWLINE).slice(1, -1);
  return featureLines.map(function (feat) {
    return feat.trim().toLowerCase();
  }).filter(function (feat) {
    return !!feat;
  });
};

// Below this point all the methods are action helpers for FTP that compose
// several actions in one command
Ftp.prototype.getFeatures = function (callback) {
  if (this.features) {
    return callback(null, this.features);
  }

  var self = this;
  this.raw.feat(function (err, response) {
    self.features = err ? [] : self._parseFeats(response.text);
    self.raw.syst(function (err, res) {
      if (!err && res.code === 215) {
        self.system = res.text.toLowerCase();
      }

      callback(null, self.features);
    });
  });
};

/**
 * Authenticates the user.
 *
 * @param {String} user Username
 * @param {String} pass Password
 * @param {Function} callback Follow-up function.
 */
Ftp.prototype.auth = function (_user, _pass, callback) {
  var self = this;
  var user = this.user;
  var pass = this.pass;

  if (this.authenticating === true) {
    return callback(new Error('This client is already authenticating'));
  }

  this.authenticating = true;
  this.raw.user(user, function (err, res) {
    if (err || [230, 331, 332].indexOf(res.code) === -1) {
      self.authenticating = false;
      callback(err);
      return;
    }

    self.raw.pass(pass, function (err, res) {
      self.authenticating = false;

      if (err) {
        callback(err);
      } else if ([230, 202].indexOf(res.code) > -1) {
        self.authenticated = true;
        self.user = user;
        self.pass = pass;
        self.raw.type('I', function () {
          callback(undefined, res);
        });
      } else if (res.code === 332) {
        self.raw.acct(''); // ACCT not really supported
      }
    });
  });
};

Ftp.prototype.setType = function (type, callback) {
  type = type.toUpperCase();
  if (this.type === type) {
    return callback();
  }

  var self = this;
  this.raw.type(type, function (err, data) {
    if (!err) self.type = type;

    callback(err, data);
  });
};

/**
 * Lists a folder's contents using a passive connection.
 *
 * @param {String} path Remote path for the file/folder to retrieve
 * @param {Function} callback Function to call with errors or results
 */
Ftp.prototype.list = function (path, callback) {
  var _this5 = this;

  if (arguments.length === 1) {
    callback = arguments[0];
    path = '';
  }

  var listing = '';
  callback = once(callback);

  this.getPasvSocket(function (err, socket) {
    if (err) return callback(err);

    socket.on('data', function (data) {
      return listing += data.toString('binary');
    });

    _this5.pasvTimeout.call(_this5, socket, callback);

    socket.once('close', function (err) {
      return callback(err, listing);
    });
    socket.once('error', callback);

    function cmdCallback(err, res) {
      if (err) {
        return callback(err);
      }var isExpectedMark = expectedMarks.marks.some(function (mark) {
        return mark === res.code;
      });

      if (!isExpectedMark) {
        callback(new Error('Expected marks ' + expectedMarks.toString() + ' instead of: ' + res.text));
      }
    }

    cmdCallback.expectsMark = expectedMarks;

    _this5.execute('list ' + (path || ''), cmdCallback);
  });
};

Ftp.prototype.emitProgress = function (data) {
  this.emit('progress', {
    filename: data.filename,
    action: data.action,
    total: data.totalSize || 0,
    transferred: data.socket[data.action === 'get' ? 'bytesRead' : 'bytesWritten']
  });
};

/**
 * Depending on the number of parameters, returns the content of the specified
 * file or directly saves a file into the specified destination. In the latter
 * case, an optional callback can be provided, which will receive the error in
 * case the operation was not successful.
 *
 * @param {String} remotePath File to be retrieved from the FTP server
 * @param {Function|String} localPath Local path where we create the new file
 * @param {Function} [callback] Gets called on either success or failure
 */
Ftp.prototype.get = function (remotePath, localPath, callback) {
  var self = this;
  var finalCallback;

  if (typeof localPath === 'function') {
    finalCallback = once(localPath || NOOP);
  } else {
    callback = once(callback || NOOP);
    finalCallback = function (err, socket) {
      if (err) {
        return callback(err);
      }

      var writeStream = fs.createWriteStream(localPath);
      writeStream.on('error', callback);

      socket.on('readable', function () {
        self.emitProgress({
          filename: remotePath,
          action: 'get',
          socket: socket
        });
      });

      // This ensures that any expected outcome is handled. There is no
      // danger of the callback being executed several times, because it is
      // wrapped in `once`.
      socket.on('error', callback);
      socket.on('end', callback);
      socket.on('close', callback);

      socket.pipe(writeStream);
      socket.resume();
    };
  }

  this.getGetSocket(remotePath, finalCallback);
};

/**
 * Returns a socket for a get (RETR) on a path. The socket is ready to be
 * streamed, but it is returned in a paused state. It is left to the user to
 * resume it.
 *
 * @param {String} path Path to the file to be retrieved
 * @param {Function} callback Function to call when finalized, with the socket
 * as a parameter
 */
Ftp.prototype.getGetSocket = function (path, callback) {
  var self = this;
  callback = once(callback);
  this.getPasvSocket(function (err, socket) {
    if (err) return cmdCallback(err);

    socket.on('error', function (err) {
      if (err.code === 'ECONNREFUSED') {
        err.msg = 'Probably trying a PASV operation while one is in progress';
      }
      cmdCallback(err);
    });

    self.pasvTimeout.call(self, socket, cmdCallback);
    socket.pause();

    function cmdCallback(err, res) {
      if (err) {
        return callback(err);
      }

      if (!socket) {
        return callback(new Error('Error when retrieving PASV socket'));
      }

      if (res.code === 125 || res.code === 150) {
        return callback(null, socket);
      }

      return callback(new Error('Unexpected command ' + res.text));
    }

    cmdCallback.expectsMark = expectedMarks;
    self.execute('retr ' + path, cmdCallback);
  });
};

/**
 * Uploads contents on a FTP server. The `from` parameter can be a Buffer or the
 * path for a local file to be uploaded.
 *
 * @param {String|Buffer} from Contents to be uploaded.
 * @param {String} to path for the remote destination.
 * @param {Function} callback Function to execute on error or success.
 */
Ftp.prototype.put = function (from, to, callback) {
  var self = this;

  function putReadable(from, to, totalSize, callback) {
    from.on('readable', function () {
      self.emitProgress({
        filename: to,
        action: 'put',
        socket: from,
        totalSize: totalSize
      });
    });

    self.getPutSocket(to, function (err, socket) {
      if (err) return;
      from.pipe(socket);
    }, callback);
  }

  if (from instanceof Buffer) {
    this.getPutSocket(to, function (err, socket) {
      return !err && socket.end(from);
    }, callback);
  } else if (typeof from === 'string') {
    fs.stat(from, function (err, stats) {
      if (err && err.code === 'ENOENT') {
        return callback(new Error('Local file doesn\'t exist.'));
      }

      var totalSize = err ? 0 : stats.size;
      var localFileStream = fs.createReadStream(from, {
        bufferSize: 4 * 1024
      });
      putReadable(localFileStream, to, totalSize, callback);
    });
  } else {
    // `from` is a readable stream
    putReadable(from, to, from.size, callback);
  }
};

Ftp.prototype.getPutSocket = function (path, callback) {
  var doneCallback = arguments[2] === undefined ? NOOP : arguments[2];

  if (!callback) {
    throw new Error('A callback argument is required.');
  }

  doneCallback = once(doneCallback);
  var _callback = once(function (err, _socket) {
    if (err) {
      callback(err);
      return doneCallback(err);
    }
    return callback(null, _socket);
  });

  var self = this;
  this.getPasvSocket(function (err, socket) {
    if (err) return _callback(err);
    socket.on('close', doneCallback);
    socket.on('error', doneCallback);

    var putCallback = once(function putCallback(err, res) {
      if (err) {
        return _callback(err);
      } // Mark 150 indicates that the 'STOR' socket is ready to receive data.
      // Anything else is not relevant.
      if (res.code === 125 || res.code === 150) {
        self.pasvTimeout.call(self, socket, doneCallback);
        return _callback(null, socket);
      }

      return _callback(new Error('Unexpected command ' + res.text));
    });

    putCallback.expectsMark = expectedMarks;

    self.execute('stor ' + path, putCallback);
  });
};

Ftp.prototype.pasvTimeout = function (socket, cb) {
  var _this6 = this;

  socket.once('timeout', function () {
    debug('PASV socket timeout');
    _this6.emit('timeout');
    socket.end();
    cb(new Error('Passive socket timeout'));
  });
};

Ftp.prototype.getPasvSocket = function () {
  var callback = arguments[0] === undefined ? NOOP : arguments[0];

  var self = this;
  callback = once(callback);

  this.execute('pasv', function (err, res) {
    if (err) return callback(err);

    getPasvPort(res.text, function (err, options) {
      if (err) return callback(err);

      var socket = self._pasvSocket = Net.createConnection(options);
      socket.setTimeout(self.timeout || TIMEOUT);
      socket.once('connect', function () {
        return self._pasvSocket = socket;
      });
      socket.once('close', function () {
        return self._pasvSocket = undefined;
      });

      callback(null, socket);
    });
  });
};

/**
 * Provides information about files. It lists a directory contents or
 * a single file and yields an array of file objects. The file objects
 * contain several properties. The main difference between this method and
 * 'list' or 'stat' is that it returns objects with the file properties
 * already parsed.
 *
 * Example of file object:
 *
 *  {
 *      name: 'README.txt',
 *      type: 0,
 *      time: 996052680000,
 *      size: '2582',
 *      owner: 'sergi',
 *      group: 'staff',
 *      userPermissions: { read: true, write: true, exec: false },
 *      groupPermissions: { read: true, write: false, exec: false },
 *      otherPermissions: { read: true, write: false, exec: false }
 *  }
 *
 * The constants used in the object are defined in ftpParser.js
 *
 * @param {String} filePath Path to the file or directory to list
 * @param {Function} callback Function to call with the proper data when
 * the listing is finished.
 */
Ftp.prototype.ls = function (filePath, callback) {
  function entriesToList(err, entries) {
    if (err) {
      return callback(err);
    }ListingParser.parseFtpEntries(entries.text || entries, callback);
  }

  if (this.useList) {
    this.list(filePath, entriesToList);
  } else {
    var self = this;
    this.raw.stat(filePath, function (err, data) {
      // We might be connected to a server that doesn't support the
      // 'STAT' command, which is set as default. We use 'LIST' instead,
      // and we set the variable `useList` to true, to avoid extra round
      // trips to the server to check.
      if (err && (err.code === 502 || err.code === 500) || self.system && self.system.indexOf('hummingbird') > -1)
        // Not sure if the 'hummingbird' system check ^^^ is still
        // necessary. If they support any standards, the 500 error
        // should have us covered. Let's leave it for now.
        {
          self.useList = true;
          self.list(filePath, entriesToList);
        } else {
        entriesToList(err, data);
      }
    });
  }
};

Ftp.prototype.rename = function (from, to, callback) {
  var _this7 = this;

  this.raw.rnfr(from, function (err) {
    if (err) return callback(err);

    _this7.raw.rnto(to, callback);
  });
};

Ftp.prototype.keepAlive = function (wait) {
  if (this._keepAliveInterval) {
    clearInterval(this._keepAliveInterval);
  }

  this._keepAliveInterval = setInterval(this.raw.noop, wait || IDLE_TIME);
};

Ftp.prototype.destroy = function () {
  if (this._keepAliveInterval) {
    clearInterval(this._keepAliveInterval);
  }

  if (this.socket && this.socket.writable) {
    this.socket.end();
  }

  if (this._pasvSocket && this._pasvSocket.writable) {
    this._pasvSocket.end();
  }

  this.resParser.end();

  this.socket = undefined;
  this._pasvSocket = undefined;

  this.features = null;
  this.authenticated = false;
};
