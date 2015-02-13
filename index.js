var tls = require('tls');
var hpack = require('./hpack.js');
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

  var localSettings = initialSettings.concat(); //copy
  var remoteSettings = initialSettings.concat(); //copy

  var context = {
    localSettings: localSettings,
    remoteSettings: remoteSettings,
    encoder: hpack(localSettings[_.SETTINGS_HEADER_TABLE_SIZE]),
    decoder: hpack(localSettings[_.SETTINGS_HEADER_TABLE_SIZE]),
    streams: ['open'],
    streamData: [],
    createNewStream: function() {
      latestServerStreamId = latestServerStreamId + 2;
      context.streams[latestServerStreamId] = 'idle';
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
  // console.log(buf.length, length);
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
      sendGoAway(socket, context, code);
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
  message && console.log('  ERR: ' + message);
  throw new Error(code);
}


function processFrame(socket, context, frame) {

  console.log('[' + frame.streamId + '] ' + _.FRAME_NAME[frame.type]);
  //6.2
  if (context.headerFragment) {
    if (frame.type !== _.TYPE_CONTINUATION) {
      error(_.ERROR_PROTOCOL_ERROR, 'error3');
    }
    if (context.headerFragment.streamId !== frame.streamId) {
      error(_.ERROR_PROTOCOL_ERROR, 'error4');
    }
  }
  //TODO ↑と↓が順序に依存している…
  //6.1
  var state = context.streams[frame.streamId];
  if (frame.type === _.TYPE_DATA && state !== 'open' && state !== 'half-closed-local') {
    error(_.ERROR_STREAM_CLOSED, 'stream [' + frame.streamId + '] is ' + state);
  }

  //4.2
  if (frame.payload.length > context.localSettings[_.SETTINGS_MAX_FRAME_SIZE]) {
    error(_.ERROR_FRAME_SIZE_ERROR, 'error1');
  }

  updateStream(context, frame);

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

  var padded = !!(frame.flags & 0x8);
  var data;
  if (padded) {
    var padLength = frame.payload.readUInt8(0);
    data = frame.payload.slice(1, frame.payload.length - padLength);
  } else {
    data = frame.payload;
  }
  var headers = context.streamData[frame.streamId].headers;
  var endStream = !!(frame.flags & 0x1);
  context.streamData[frame.streamId].data = Buffer.concat([context.streamData[frame.streamId].data, data]);
  if (endStream) {
    handleRequest(socket, context, frame.streamId, headers, context.streamData[frame.streamId].data);
  }
}

function processHEADERS(socket, context, frame) {
  if (frame.streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  var endStream = !!(frame.flags & 0x1);
  var endHeaders = !!(frame.flags & 0x4);
  var padded = !!(frame.flags & 0x8);
  var priority = !!(frame.flags & 0x20);

  var headerBlockFragment = context.headerFragment ?
    Buffer.concat([context.headerFragment.headerBlockFragment, frame.payload]) :
    readHeaderBlockFragment(padded, priority, frame.payload);

  if (!endHeaders) {
    context.headerFragment = {
      endStream: context.headerFragment ? context.headerFragment.endStream : endStream,
      flags: frame.flags,
      streamId: frame.streamId,
      headerBlockFragment: headerBlockFragment
    };
    return;
  }
  var endStream = context.headerFragment ? context.headerFragment.endStream : endStream;
  context.headerFragment = null;

  var decompressed = context.decoder.decode(headerBlockFragment);

  var headers = {}
  headers.headerBlockFragment = decompressed;
  headers.data = {};
  decompressed.forEach(function(pair) {
    headers.data[pair[0]] = pair[1];
  });

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
  if (headers.data['content-length'] && +headers.data['content-length'] !== headerBlockFragment.length) {
    error(_.ERROR_PROTOCOL_ERROR);
  }

  console.log('  ' + headers.data[':method'] + ' ' + headers.data[':path']);

  context.streamData[frame.streamId] = {
    headers: headers,
    data: new Buffer(0)
  };
  if (endStream) {
    // console.log('endStream' + frame.flags);
    handleRequest(socket, context, frame.streamId, headers);
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
    sendSettings(socket, context);
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
    sendPing(socket, context, frame.streamId, frame.payload);
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
    if (identifier == _.SETTINGS_INITIAL_WINDOW_SIZE && value > 2147483647) {
      error(_.ERROR_FLOW_CONTROL_ERROR);
    }
    //6.5.2
    if (identifier == _.SETTINGS_MAX_FRAME_SIZE && (value < 65535 || value > 16777215)) {
      error(_.ERROR_PROTOCOL_ERROR);
    }
    context.remoteSettings[identifier] = value;
  }
}

function readHeaderBlockFragment(padded, priority, payload) {
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
  return payload.slice(offset); //assume padding does not exist
}

function sendSettings(socket, context) {
  // FRAME 1 -----------//
  var settingCount = 4; //TODO
  var payloadLength = 6 * settingCount;

  var header = writeHeader(payloadLength, _.TYPE_SETTINGS, 0x0, 0);
  var payload = new Buffer(payloadLength);
  for (var i = 0; i < settingCount; i++) {
    var number = i + 1;
    payload.writeUInt16BE(number, i * 6);
    payload.writeUInt32BE(context.localSettings[number], i * 6 + 2);
  }
  var all = Buffer.concat([header, payload]);
  send(socket, context, all);

  // FRAME 2 -----------//
  header = writeHeader(0, _.TYPE_SETTINGS, 0x1, 0);
  send(socket, context, header);
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
      // HEADERS
      var compressed = context.encoder.encode(headers);
      var payloadLength = compressed.length;
      var header = writeHeader(payloadLength, _.TYPE_HEADERS, flags, streamId);
      var all = Buffer.concat([header, compressed]);
      send(socket, context, all);

      // BODY
      var payload = new Buffer(data ? data : 0);
      var payloadLength = payload.length;
      var flags = 0x1; // end_stream
      var header = writeHeader(payloadLength, _.TYPE_DATA, flags, streamId);
      var all = Buffer.concat([header, payload]);
      send(socket, context, all);

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
  var compressedResponseHeader = context.encoder.encode(headers);

  var payloadLength = compressedResponseHeader.length + 4;

  var flags = 0x4; // end_headers
  var header = writeHeader(payloadLength, _.TYPE_PUSH_PROMISE, flags, streamId);
  var payload = new Buffer(payloadLength);
  payload.writeUInt32BE(promisedStreamId, 0);
  compressedResponseHeader.copy(payload, 4);
  var all = Buffer.concat([header, payload]);
  send(socket, context, all, promisedStreamId);

  handleRequest(socket, context, promisedStreamId, {
    headerBlockFragment: requestHeaders.headerBlockFragment,
    data: {
      ':path': relatedPath
    }
  });
}

function sendPing(socket, context, streamId, payload) {
  var payloadLength = 8;
  var flags = 0x1; // ack
  var header = writeHeader(payloadLength, _.TYPE_PING, flags, streamId);
  var all = Buffer.concat([header, payload]);
  send(socket, context, all);
}

function sendGoAway(socket, context, errorCode) {
  var lastStreamId = context.streams.length - 1;
  var payloadLength = 8;
  var flags = 0x0;

  var header = writeHeader(payloadLength, _.TYPE_GOAWAY, flags, 0);
  var payload = new Buffer(payloadLength);
  payload.writeUInt32BE(lastStreamId, 0);
  payload.writeUInt32BE(errorCode, 4);
  var all = Buffer.concat([header, payload]);
  send(socket, context, all, _.ERROR_NAME[errorCode]);
  socket.end();
}

function writeHeader(length, type, flags, streamId) {
  var buffer = new Buffer(9);
  buffer.writeUInt32BE(length << 8, 0);
  buffer.writeUInt8(type, 3);
  buffer.writeUInt8(flags, 4);
  buffer.writeUInt32BE(streamId, 5);
  return buffer;
}

function send(socket, context, buffer, info) {
  var frame = readFrame(buffer);
  var typeName = _.FRAME_NAME[frame.type];

  updateStream(context, frame, true);
  console.log('  => [' + buffer.readUInt32BE(5) + '] ' + typeName + (info ? ': ' + info : ''));
  socket.write(buffer);
}

function isEndStream(frame) {
  return (frame.type === _.TYPE_HEADERS || frame.type === _.TYPE_DATA) && !!(frame.flags & 0x1);
}

function isActiveStream(state) {
  return state && (state === 'open' || state.indexOf('half-closed') === 0);
}

function updateStream(context, frame, send) {
  var state = context.streams[frame.streamId];
  var endStream = isEndStream(frame);
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

  if (!state || state === 'idle') {
    if (frame.type === _.TYPE_HEADERS) {
      context.streams[frame.streamId] = 'open';
    } else if (send && frame.type === _.TYPE_PUSH_PROMISE) {
      context.streams[frame.streamId] = 'reserved-local';
    } else if (!send && frame.type === _.TYPE_PUSH_PROMISE) {
      context.streams[frame.streamId] = 'reserved-remote';
    }
  } else if (state === 'reserved-local') {
    if (frame.type === _.TYPE_RST_STREAM) {
      context.streams[frame.streamId] = 'closed';
    } else if (send && frame.type === _.TYPE_HEADERS) {
      context.streams[frame.streamId] = 'half-closed-remote';
    }
  } else if (state === 'reserved-remote') {
    if (frame.type === _.TYPE_RST_STREAM) {
      context.streams[frame.streamId] = 'closed';
    } else if (!send && frame.type === _.TYPE_HEADERS) {
      context.streams[frame.streamId] = 'half-closed-local';
    }
  } else if (state === 'open') {
    if (frame.type === _.TYPE_RST_STREAM) {
      context.streams[frame.streamId] = 'closed';
    }
  } else if (state === 'half-closed-remote') {
    if (frame.type === _.TYPE_RST_STREAM) {
      context.streams[frame.streamId] = 'closed';
    }
  } else if (state === 'half-closed-local') {
    if (frame.type === _.TYPE_RST_STREAM) {
      context.streams[frame.streamId] = 'closed';
    }
  }

  if (!send && isActiveStream(context.streams[frame.streamId])) {
    var count = 0;
    for (var i = 0; i < context.streams.length; i++) {
      if (i % 2 === 1 && isActiveStream(context.streams[i])) {
        count++;
      }
    }
    if (count > context.localSettings[_.SETTINGS_MAX_CONCURRENT_STREAMS]) {
      // console.log(count, context.localSettings[_.SETTINGS_MAX_CONCURRENT_STREAMS]);
      error(_.ERROR_PROTOCOL_ERROR, 'error5');
    }
  }

  state = context.streams[frame.streamId];

  // endStream
  if (state === 'open') {
    if (!send && endStream) {
      context.streams[frame.streamId] = 'half-closed-remote';
    } else if (send && endStream) {
      console.log(123)
      context.streams[frame.streamId] = 'half-closed-local';
    }
  } else if (state === 'half-closed-remote') {
    if (send && endStream) {
      context.streams[frame.streamId] = 'closed';
    }
  } else if (state === 'half-closed-local') {
    if (!send && endStream) {
      console.log(456)
      context.streams[frame.streamId] = 'closed';
    }
  }


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