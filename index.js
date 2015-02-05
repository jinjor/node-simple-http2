var fs = require('fs');
var tls = require('tls');
var assert = require('assert');
var hpack = require('./sasazka/lib/hpack.js');

var _ = require('./constants.js');

var options = {
  key: fs.readFileSync('./ssl/server.key'),
  cert: fs.readFileSync('./ssl/server.crt'),
  requestCert: true,
  rejectUnauthorized: false,
  NPNProtocols: ['h2-14', 'h2-16', 'http/1.1', 'http/1.0'], //unofficial
};

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
    start(socket);
  } else {
    assert.fail('socket.npnProtocol:' + socket.npnProtocol);
  }
});
server.listen(8443);


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


function createContext() {

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
    tryPushPromise: function(socket, context, streamId, requestHeaders) {
      var path = requestHeaders.data[':path'];
      if (path === '/') {
        var promisedStreamId = context.createNewStream();
        context.streams[promisedStreamId] = true; //TODO
        sendPushPromise(socket, context, streamId, requestHeaders, promisedStreamId, '/app.css');
        sendResponseHTML(socket, context, promisedStreamId, {
          headerBlockFragment: requestHeaders.headerBlockFragment,
          data: {
            ':path': '/app.css'
          }
        });
      }

    }
  };
  return context;
}


function start(socket) {
  context = createContext();
  var preface = new Buffer('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

  socket.once('readable', function() {
    var buf = socket.read();
    for (var i = 0; i < preface.length; i++) {
      if (buf[i] !== preface[i]) {
        console.log('Received invalid connection preface.');
        socket.end(); //TODO send GOAWAY 0x1かも（3.5）
        return;
      }
    }
    console.log('Received valid connection preface.');
    mainLoop(socket, context, buf.slice(preface.length));
  });
}

function mainLoop(socket, context, buf) {
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
  var prev = new Buffer(0);

  var read = function(socket, context, buf) {
    try {
      buf = Buffer.concat([prev, buf]);
      while (buf.length > 0) {
        var length = buf.readUInt32BE(0) >> 8;
        var type = buf.readUInt8(3);
        var flags = buf.readUInt8(4);
        var streamId = buf.readUInt32BE(5);
        if (buf.length >= 9 + length) {
          var body = buf.slice(9, 9 + length);
          buf = buf.slice(9 + length);
          processFrame(socket, context, type, flags, streamId, body);
        } else {
          break;
        }
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


function processFrame(socket, context, type, flags, streamId, payload) {
  console.log('[' + streamId + '] ' + _.FRAME_NAME[type]);
  //4.2
  if (payload.length > context.settings[_.SETTINGS_MAX_FRAME_SIZE]) {
    error(_.ERROR_FRAME_SIZE_ERROR, 'error1');
  }
  //5.1.1
  if (streamId >= 2 && streamId % 2 === 0 && context.streams[streamId] === undefined) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  //5.1.1
  if (streamId % 2 === 1) {
    for (var i = context.streams.length - 1; i > streamId; i--) {
      if (i % 2 === 1 && context.streams[i]) {
        error(_.ERROR_PROTOCOL_ERROR, 'error2');
      }
    }
  }


  //6.2
  if (context.headerFragment) {
    if (type !== _.TYPE_CONTINUATION) {
      error(_.ERROR_PROTOCOL_ERROR, 'error3');
    }
    if (context.headerFragment.streamId !== streamId) {
      error(_.ERROR_PROTOCOL_ERROR, 'error4');
    }
  }

  context.streams[streamId] = context.streams[streamId] || 1; //idle?

  //5.1.2
  var count = 0;
  for (var i = 0; i < context.streams.length; i++) {
    if (i % 2 === 1 && context.streams[i]) { //client side
      count++;
    }
  }
  if (count > context.settings[_.SETTINGS_MAX_CONCURRENT_STREAMS]) {
    error(_.ERROR_PROTOCOL_ERROR, 'error5');
  }

  var process = processes[type];
  if (process) {
    process(socket, context, flags, streamId, payload);
  } else {
    error(_.ERROR_PROTOCOL_ERROR, 'error6'); //TODO
  }
}

function processDATA(socket, context, flags, streamId, payload) {
  if (streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (context.streams[streamId] !== 2) {
    error(_.ERROR_STREAM_CLOSED);
  }
}

function processHEADERS(socket, context, flags, streamId, payload) {
  if (streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  // flags = context.headerFragment ? context.headerFragment.flags : flags;
  // streamId = context.headerFragment ? context.headerFragment.streamId : streamId;
  payload = context.headerFragment ? Buffer.concat([context.headerFragment.payload, payload]) : payload;
  var endStream = !!(flags & 0x1);
  var endHeaders = !!(flags & 0x4);
  var padded = !!(flags & 0x8);
  var priority = !!(flags & 0x20);
  var headers = readHeaders(context, padded, priority, payload);

  if (!endHeaders) {
    context.headerFragment = {
      flags: flags,
      streamId: streamId,
      payload: payload
    };
    return;
  }
  context.headerFragment = null;
  context.streams[streamId] = 2; //open

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
  sendResponseHTML(socket, context, streamId, headers);
}


function processPRIORITY(socket, context, flags, streamId, payload) {
  if (streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (payload.length !== 5) {
    error(_.ERROR_FRAME_SIZE_ERROR);
  }
  readPriority(flags, payload);
}

function processSETTINGS(socket, context, flags, streamId, payload) {
  if (streamId !== 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  var ack = !!(flags & 0x1);
  if (ack) {
    if (payload.length !== 0) {
      error(_.ERROR_FRAME_SIZE_ERROR);
    }
  } else {
    if (payload.length % 6 !== 0) {
      error(_.ERROR_FRAME_SIZE_ERROR);
    }
    applySettings(context, payload);
    sendSettings(socket, context.settings);
  }
}

function processPUSH_PROMISE(socket, context, flags, streamId, payload) {
  error(_.ERROR_PROTOCOL_ERROR);
}

function processWINDOW_UPDATE(socket, context, flags, streamId, payload) {
  if (payload.length % 4 !== 0) {
    error(_.ERROR_FRAME_SIZE_ERROR);
  }
  var windowSizeIncrement = payload.readUInt32BE(0);
  if (windowSizeIncrement === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  console.log('  ' + windowSizeIncrement);
}

function processCONTINUATION(socket, context, flags, streamId, payload) {
  if(!context.headerFragment) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  processHEADERS(socket, context, flags, streamId, payload);
}

function processRST_STREAM(socket, context, flags, streamId, payload) {
  if (streamId === 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (context.streams[streamId] === 1) { //idle
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (payload.length !== 4) {
    error(_.ERROR_FRAME_SIZE_ERROR);
  }
}

function processPING(socket, context, flags, streamId, payload) {
  if (streamId !== 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
  if (payload.length !== 8) {
    error(_.ERROR_FRAME_SIZE_ERROR);
  }
  var ack = !!(flags & 0x1);
  if (!ack) {
    sendPing(socket, streamId, payload);
  }
}

function processGOAWAY(socket, context, flags, streamId, payload) {
  if (streamId !== 0) {
    error(_.ERROR_PROTOCOL_ERROR);
  }
}

function applySettings(context, payload) {
  for (i = 0; i < payload.length; i += 6) {
    var identifier = payload.readUInt16BE(i);
    var value = payload.readUInt32BE(i + 2);
    //6.5.2
    if(identifier == _.SETTINGS_ENABLE_PUSH && value !== 0 && value !== 1) {
      error(_.ERROR_PROTOCOL_ERROR);
    }
    //6.5.2
    if(identifier == _.SETTINGS_INITIAL_WINDOW_SIZE) {
      //TODO
    }
    //6.5.2
    if(identifier == _.SETTINGS_MAX_FRAME_SIZE) {
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

function readPriority(flags, payload) {

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
  assert.equal(9 + payloadLength, buffer.length);

  send(socket, buffer);

  // FRAME 2 -----------//
  // header
  buffer = new Buffer(9);
  writeHeader(buffer, 0, _.TYPE_SETTINGS, 0x1, 0);

  send(socket, buffer);
}

function sendResponseHTML(socket, context, streamId, requestHeaders) {

  context.tryPushPromise && context.tryPushPromise(socket, context, streamId, requestHeaders);

  var path = requestHeaders.data[':path'];
  if (path === '/') {
    path = 'index.html';
  } else {
    path = path.substring(1);
  }

  var headers = [];
  headers[0] = [':status', '200'];
  if (path.indexOf('.html') >= 0) {
    headers[1] = ['content-type', 'text/html'];
  } else {
    headers[1] = [':path', '/app.css'];
    headers[2] = ['content-type', 'text/css'];
  }
  var compressed = context.compressor.compress(headers);

  var payloadLength = compressed.length;
  var header = new Buffer(9);

  var flags = 0x4; // end_headers
  // header
  writeHeader(header, payloadLength, _.TYPE_HEADERS, flags, streamId);

  var buffer = Buffer.concat([header, compressed]);
  send(socket, buffer);

  // BODY -------------//
  var data = new Buffer(fs.readFileSync(path));

  var payloadLength = data.length
  var header = new Buffer(9);

  var flags = 0x1; // end_stream
  // header
  writeHeader(header, payloadLength, _.TYPE_DATA, flags, streamId);

  var buffer = Buffer.concat([header, data]);
  send(socket, buffer);
}


function sendPushPromise(socket, context, streamId, requestHeaders, promisedStreamId, relatedPath) {
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
  send(socket, buffer, promisedStreamId);
}

function sendPing(socket, streamId, payload) {
  var header = new Buffer(9);
  var payloadLength = 8;
  var flags = 0x1; // ack

  var buffer = new Buffer(9 + payloadLength);
  writeHeader(buffer, payloadLength, _.TYPE_PING, flags, streamId);
  payload.copy(buffer, 9);

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