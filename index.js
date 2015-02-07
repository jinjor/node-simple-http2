var tls = require('tls');
var hpack = require('./sasazka/lib/hpack.js');
var _ = require('./constants.js');
var assign = require('object-assign');

var processes = [];
processes[_.TYPE_DATA] = processDATA;
processes[_.TYPE_HEADERS] = processHEADERS;
processes[_.TYPE_PRIORITY] = processPRIORITY;
processes[_.TYPE_RST_STREAM] = processRST_STREAM;
processes[_.TYPE_SETTINGS] = processSETTINGS;
processes[_.TYPE_PUSH_PROMISE] = processPUSH_PROMISE;
processes[_.TYPE_PING] = processPING;
processes[_.TYPE_GOAWAY] = processGOAWAY;
processes[_.TYPE_WINDOW_UPDATE] = processWINDOW_UPDATE;
processes[_.TYPE_CONTINUATION] = processCONTINUATION;

var PREFACE = new Buffer('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

function createContext(handler) {

  var latestServerStreamId = 0;
  var initialSettings = [];
  initialSettings[_.SETTINGS_HEADER_TABLE_SIZE] = 4096;
  initialSettings[_.SETTINGS_ENABLE_PUSH] = 1;
  initialSettings[_.SETTINGS_MAX_CONCURRENT_STREAMS] = 1024;
  initialSettings[_.SETTINGS_INITIAL_WINDOW_SIZE] = 65535;
  initialSettings[_.SETTINGS_MAX_FRAME_SIZE] = 16384;
  initialSettings[_.SETTINGS_MAX_HEADER_LIST_SIZE] = Infinity;

  var context = {
    settings: initialSettings,
    compressor: hpack.createContext(),
    decompressor: hpack.createContext(),
    streams: [true],
    createNewStream: function() {
      latestServerStreamId = latestServerStreamId + 2;
      context.streams[latestServerStreamId] = true; //TODO
      return latestServerStreamId;
    },
    handler: handler
  };
  return context;
}

//3.5
function checkConnectionPreface(buf) {
  for (var i = 0; i < PREFACE.length; i++) {
    if (buf[i] !== PREFACE[i]) {
      throw new Error('Received invalid connection preface.');
    }
  }
}

function start(socket, handler) {

  socket.once('readable', function() {
    try {
      var buf = socket.read();
      checkConnectionPreface(buf);
      console.log('Received valid connection preface.');
      var context = createContext(handler);
      mainLoop(socket, context, buf.slice(PREFACE.length));
    } catch (e) {
      console.log(e.message);
      socket.end();
    }
  });
}

function readFrame(buf) {
  //   0                   1                   2                   3
  //   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
  //  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  //  |                 Length (24)                   |
  //  +---------------+---------------+---------------+
  //  |   Type (8)    |   Flags (8)   |
  //  +-+-+-----------+---------------+-------------------------------+
  //  |R|                 Stream Identifier (31)                      |
  //  +=+=============================================================+
  //  |                   Frame Payload (0...)                      ...
  //  +---------------------------------------------------------------+
  var length = buf.readUInt32BE(0) >> 8;
  if (buf.length < 9 + length) {
    return null;
  }
  var type = buf.readUInt8(3);
  var flags = buf.readUInt8(4);
  var streamId = buf.readUInt32BE(5);
  var payload = buf.slice(9, 9 + length);
  return {
    type: type,
    flags: flags,
    streamId: streamId,
    payload: payload
  };
}


function mainLoop(socket, context, buf) {

  var prev = new Buffer(0);

  var read = function(socket, context, buf) {
    try {
      buf = Buffer.concat([prev, buf]);
      while (buf.length > 0) {
        var frame = readFrame(buf);
        if (!frame) {
          break;
        }
        buf = buf.slice(9 + frame.payload.length);
        processFrame(socket, context, frame);
      }
      prev = buf;
    } catch (e) {
      var code = +e.message;
      if (isNaN(code)) {
        console.log(e.stack);
        code = _.ERROR_INTERNAL_ERROR;
      }
      sendGoAway(socket, context.streams.length - 1, code);
    }
  }
  read(socket, context, buf);

  socket.on('readable', function() { // assume synchronized & sequencial
    var buf = socket.read();
    if (!buf) {
      return;
    }
    read(socket, context, buf);
  });
}

function error(code, message) {
  message && console.log(message);
  throw new Error(code);
}


function processFrame(socket, context, frame) {
  console.log('[' + frame.streamId + '] ' + _.FRAME_NAME[frame.type]);
  //4.2
  if (frame.payload.length > context.settings[_.SETTINGS_MAX_FRAME_SIZE]) {
    error(_.ERROR_FRAME_SIZE_ERROR, 'error1');
  }
  //5.1.1
  if (frame.streamId >= 2 && frame.streamId % 2 === 0 && context.streams[frame.streamId] === undefined) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  //5.1.1
  if (frame.streamId % 2 === 1) {
    for (var i = context.streams.length - 1; i > frame.streamId; i--) {
      if (i % 2 === 1 && context.streams[i]) {
        error(_.ERROR_PROTOCOL_ERROR, 'error2');
      }
    }
  }

  //6.2
  if (context.headerFragment) {
    if (frame.type !== _.TYPE_CONTINUATION) {
      error(_.ERROR_PROTOCOL_ERROR, 'error3');
    }
    if (context.headerFragment.streamId !== frame.streamId) {
      error(_.ERROR_PROTOCOL_ERROR, 'error4');
    }
  }

  var process = processes[frame.type];
  if (process) {
    process(socket, context, frame);
  } else {
    error(_.ERROR_PROTOCOL_ERROR, 'error6'); //TODO
  }
}

function processDATA(socket, context, frame) {
  //6.1
  if (frame.streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  //6.1
  console.log(context.streams[frame.streamId]);
  if (context.streams[frame.streamId] !== 'open') {
    error(_.ERROR_STREAM_CLOSED);
  }
  var endStream = !!(frame.flags & 0x1);
  if (context.streams[frame.streamId] === 'open' && endStream) {
    //recv ES
    context.streams[frame.streamId] = 'half closed (remote)';
  }
}

function processHEADERS(socket, context, frame) {
  if (frame.streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  // flags = context.headerFragment ? context.headerFragment.flags : flags;
  // streamId = context.headerFragment ? context.headerFragment.streamId : streamId;
  var payload = context.headerFragment ? Buffer.concat([context.headerFragment.payload, frame.payload]) : frame.payload;
  var endStream = !!(frame.flags & 0x1);
  var endHeaders = !!(frame.flags & 0x4);
  var padded = !!(frame.flags & 0x8);
  var priority = !!(frame.flags & 0x20);
  var headers = readHeaders(context, padded, priority, payload);

  if (!endHeaders) {
    context.headerFragment = {
      flags: frame.flags,
      streamId: frame.streamId,
      payload: payload
    };
    return;
  }
  context.headerFragment = null;

  //8.1.2
  var keys = Object.keys(headers.data);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key.toLowerCase() !== key) {

      error(_.ERROR_PROTOCOL_ERROR);
    }
  }
  //8.1.2.1
  var keys = Object.keys(headers.data);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key[0] === ':') {
      if (key !== ':method' && key !== ':scheme' && key !== ':authority' && key !== ':path') {
        console.log('error2');
        error(_.ERROR_PROTOCOL_ERROR);
      }
    }
  }
  //8.1.2.1
  for (var i = 0; i < headers.headerBlockFragment.length; i++) {
    var pair = headers.headerBlockFragment[i];
    if (pair[0][0] === ':' && headers.headerBlockFragment[i - 1] && headers.headerBlockFragment[i - 1][0][0] !== ':') {
      error(_.ERROR_PROTOCOL_ERROR);
    }
  }
  //8.1.2.2
  if (headers.data.connection) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  //8.1.2.2
  if (headers.data.te && headers.data.te !== 'trailers') {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  //8.1.2.3
  if (!headers.data[':method'] || !headers.data[':scheme'] || !headers.data[':path']) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  //8.1.2.6
  if (headers.data['content-length'] && +headers.data['content-length'] !== payload.length) {
    error(_.ERROR_PROTOCOL_ERROR);
  }

  console.log('  ' + headers.data[':method'] + ' ' + headers.data[':path']);
  handleRequest(socket, context, frame.streamId, headers);
  if (!context.streams[frame.streamId]) { //idle
    //recv H/
    if(endHeaders) {
      //5.1.2 // TODO 多分ここじゃない
      var count = 0;
      for (var i = 0; i < context.streams.length; i++) {
        if (i % 2 === 1 && context.streams[i]) { // open | harf closed | reserved
          count++;
        }
      }
      if (count + 1 > context.settings[_.SETTINGS_MAX_CONCURRENT_STREAMS]) {
        error(_.ERROR_PROTOCOL_ERROR, 'error5');
      }
      context.streams[frame.streamId] = 'open';
    }
  } else if (context.streams[frame.streamId] === 'reserved (remote)') {
    //recv H
    context.streams[frame.streamId] = 'half closed (remote)';
  }

  // TODO: 更新のタイミングどうしよう。
  if (context.streams[frame.streamId] === 'open') {// 直前にopenになった可能性がある
    //recv ES
    if (endStream) {
      context.streams[frame.streamId] = 'half closed (remote)';
    }
  }
}


function processPRIORITY(socket, context, frame) {
  if (frame.streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (frame.payload.length !== 5) {
    error(_.ERROR_FRAME_SIZE_ERROR);
  }
}

function processSETTINGS(socket, context, frame) {
  if (frame.streamId !== 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  var ack = !!(frame.flags & 0x1);
  if (ack) {
    if (frame.payload.length !== 0) {
      error(_.ERROR_FRAME_SIZE_ERROR);
    }
  } else {
    if (frame.payload.length % 6 !== 0) {
      error(_.ERROR_FRAME_SIZE_ERROR);
    }
    applySettings(context, frame.payload);
    sendSettings(socket, context.settings);
  }
}

function processPUSH_PROMISE(socket, context, frame) {
  error(_.ERROR_PROTOCOL_ERROR);
}

function processWINDOW_UPDATE(socket, context, frame) {
  if (frame.payload.length % 4 !== 0) {
    error(_.ERROR_FRAME_SIZE_ERROR);
  }
  var windowSizeIncrement = frame.payload.readUInt32BE(0);
  if (windowSizeIncrement === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  console.log('  ' + windowSizeIncrement);
}

function processCONTINUATION(socket, context, frame) {
  if (!context.headerFragment) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  processHEADERS(socket, context, frame);
}

function processRST_STREAM(socket, context, frame) {
  if (frame.streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (!context.streams[frame.streamId]) { //idle
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (frame.payload.length !== 4) {
    error(_.ERROR_FRAME_SIZE_ERROR);
  }
}

function processPING(socket, context, frame) {
  if (frame.streamId !== 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (frame.payload.length !== 8) {
    error(_.ERROR_FRAME_SIZE_ERROR);
  }
  var ack = !!(frame.flags & 0x1);
  if (!ack) {
    sendPing(socket, frame.streamId, frame.payload);
  }
}

function processGOAWAY(socket, context, frame) {
  if (frame.streamId !== 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
}

function applySettings(context, payload) {
  for (i = 0; i < payload.length; i += 6) {
    var identifier = payload.readUInt16BE(i);
    var value = payload.readUInt32BE(i + 2);
    //6.5.2
    if (identifier == _.SETTINGS_ENABLE_PUSH && value !== 0 && value !== 1) {
      error(_.ERROR_PROTOCOL_ERROR);
    }
    //6.5.2
    if (identifier == _.SETTINGS_INITIAL_WINDOW_SIZE) {
      //TODO
    }
    //6.5.2
    if (identifier == _.SETTINGS_MAX_FRAME_SIZE) {
      //TODO
    }
    context.settings[identifier] = value;
  }
}

function readHeaders(context, padded, priority, payload) {
  var headers = {};

  var offset = 0;
  offset += padded ? 1 : 0;
  offset += priority ? 5 : 0;

  var padLength = 0;
  if (padded) {
    padLength = payload.readUInt8(0);
  }
  // 6.2
  if (payload.length - offset - padLength < 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (priority) {
    var streamDependency = payload.readUInt32BE((padded ? 1 : 0) + 0);
    var weight = payload.readUInt8((padded ? 1 : 0) + 4);
    headers.streamDependency = streamDependency;
    headers.weight = weight;
  }
  var headerBlockFragment = payload.slice(offset); //assume padding does not exist
  var decompressed = context.decompressor.decompress(headerBlockFragment);
  headers.headerBlockFragment = decompressed;

  headers.data = {};
  decompressed.forEach(function(pair) {
    headers.data[pair[0]] = pair[1];
  });
  return headers;
}

function sendSettings(socket, settings) {
  // FRAME 1 -----------//
  var settingCount = 4; //TODO
  var payloadLength = 6 * settingCount;
  var buffer = new Buffer(9 + payloadLength);

  // header
  writeHeader(buffer, payloadLength, _.TYPE_SETTINGS, 0x0, 0);

  // payload
  for (var i = 0; i < settingCount; i++) {
    var number = i + 1;
    buffer.writeUInt16BE(number, 9 + i * 6);
    buffer.writeUInt32BE(settings[number], 9 + i * 6 + 2);
  }

  send(socket, buffer);

  // FRAME 2 -----------//
  // header
  buffer = new Buffer(9);
  writeHeader(buffer, 0, _.TYPE_SETTINGS, 0x1, 0);

  send(socket, buffer);
}

function handleRequest(socket, context, streamId, requestHeaders) {

  var req = {
    method: requestHeaders.data[':method'],
    url: requestHeaders.data[':path']
  };

  var headers = [];
  var res = {
    pushPromise: function(path) {
      sendPushPromise(socket, context, streamId, requestHeaders, path);
    },
    writeHead: function(status, _headers) {
      headers[0] = [':status', '' + status];
      Object.keys(_headers).forEach(function(key, i) { //TODO :pathは必要？
        headers[i + 1] = [key, _headers[key]];
      });
    },
    end: function(data) {
      var flags = 0x4; // end_headers
      // header
      var compressed = context.compressor.compress(headers);
      var payloadLength = compressed.length;
      var header = new Buffer(9);

      writeHeader(header, payloadLength, _.TYPE_HEADERS, flags, streamId);

      var buffer = Buffer.concat([header, compressed]);
      send(socket, buffer);

      // BODY -------------//
      var data = new Buffer(data ? data : 0);
      var payloadLength = data.length;
      var header = new Buffer(9);
      var flags = 0x1; // end_stream
      // header
      writeHeader(header, payloadLength, _.TYPE_DATA, flags, streamId);

      var buffer = Buffer.concat([header, data]);
      send(socket, buffer);
    }
  }
  context.handler && context.handler(req, res);
}


function sendPushPromise(socket, context, streamId, requestHeaders, relatedPath) {
  var promisedStreamId = context.createNewStream();

  var headers = [];
  requestHeaders.headerBlockFragment.forEach(function(header) {
    if (header[0] === ':path') {
      headers.push([':path', relatedPath]);
    } else {
      headers.push(header);
    }
  });
  var compressedResponseHeader = context.compressor.compress(headers);

  var payloadLength = compressedResponseHeader.length + 4;
  var buffer = new Buffer(9 + payloadLength);
  var flags = 0x4; // end_headers
  writeHeader(buffer, payloadLength, _.TYPE_PUSH_PROMISE, flags, streamId);

  buffer.writeUInt32BE(promisedStreamId, 9);
  compressedResponseHeader.copy(buffer, 9 + 4);

  context.streams[promisedStreamId] = 'reserved (local)';
  send(socket, buffer, promisedStreamId);

  handleRequest(socket, context, promisedStreamId, {
    headerBlockFragment: requestHeaders.headerBlockFragment,
    data: {
      ':path': relatedPath
    }
  });
}

function sendPing(socket, streamId, payload) {
  var header = new Buffer(9);
  var payloadLength = 8;
  var flags = 0x1; // ack

  var buffer = new Buffer(9 + payloadLength);
  writeHeader(buffer, payloadLength, _.TYPE_PING, flags, streamId);
  payload.copy(buffer, 9); //TODO ?

  send(socket, buffer);
}

function sendGoAway(socket, lastStreamId, errorCode) {
  var payloadLength = 8;
  var type = 0x07; // GOAWAY
  var flags = 0x0;

  var buffer = new Buffer(9 + payloadLength);

  writeHeader(buffer, payloadLength, type, flags, 0);
  //
  buffer.writeUInt32BE(lastStreamId, 9);
  buffer.writeUInt32BE(errorCode, 13);
  send(socket, buffer, _.ERROR_NAME[errorCode]);
  socket.end();
}

function writeHeader(buffer, length, type, flags, streamId) {
  buffer.writeUInt32BE(length << 8, 0);
  buffer.writeUInt8(type, 3);
  buffer.writeUInt8(flags, 4);
  buffer.writeUInt32BE(streamId, 5);
}

function send(socket, buffer, info) {
  var type = buffer.readUInt8(3);
  var typeName = _.FRAME_NAME[type];
  console.log('  => [' + buffer.readUInt32BE(5) + '] ' + typeName + (info ? ': ' + info : ''));
  socket.write(buffer);
}

function createServer(options, handler) {
  options = assign({
    requestCert: true,
    rejectUnauthorized: false,
    NPNProtocols: ['h2-14', 'h2-16', 'http/1.1', 'http/1.0'], //unofficial
  }, options);

  var server = tls.createServer(options)
  server.on('secureConnection', function(socket) {
    socket.on('close', function(isException) {
      console.log('<<end>>');
    });
    socket.on('error', function(err) {
      console.log(err.stack);
    });
    if (socket.npnProtocol === 'h2-14' || socket.npnProtocol === 'h2-16') {
      console.log();
      console.log('<<start>> protocol: ' + socket.npnProtocol);
      start(socket, handler);
    } else {
      // socket.end();
      throw new Error('socket.npnProtocol:' + socket.npnProtocol);
    }
  });
  return {
    listen: function(port) {
      server.listen(port);
    }
  };
}

module.exports = {
  createServer: createServer
};