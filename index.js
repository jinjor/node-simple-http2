var fs = require('fs');
var https = require('https');
var assert = require('assert');
var hpack = require('./sasazka/lib/hpack.js');

var CLIENT_PRELUDE = new Buffer('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

var options = {
  key: fs.readFileSync('./ssl/key.pem'),
  cert: fs.readFileSync('./ssl/cert.pem'),
  requestCert: true,
  rejectUnauthorized: false,
  NPNProtocols: ['h2-14', 'h2-16', 'http/1.1', 'http/1.0'], //unofficial
};

var server = https.createServer(options);
var originalSocketListeners = server.listeners('secureConnection');
server.removeAllListeners('secureConnection');

server.on('secureConnection', function(socket) {
  socket.on('close', function(isException) {
    console.log('closed');
  });
  if (socket.npnProtocol === 'h2-14' || socket.npnProtocol === 'h2-16') {
    start(socket);
  } else {
    assert.fail();
  }
});
server.listen(8443);

function start(socket) {
  socket.once('readable', function() {
    var buf = socket.read();
    for (var i = 0; i < CLIENT_PRELUDE.length; i++) {
      if (buf[i] !== CLIENT_PRELUDE[i]) {
        console.log(buf.toString());
        socket.error('handshake', 'PROTOCOL_ERROR');
        return;
      }
    }
    console.log('Successfully received the client connection header prelude.');
    
    if (buf.length > CLIENT_PRELUDE.length) {
      var buf = buf.slice(CLIENT_PRELUDE.length);

      while (buf.length > 0) {
        var length = buf.readUInt32BE(0) >> 8;
        var type = buf.readUInt8(3);
        var flags = buf.readUInt8(4);
        var streamId = buf.readUInt32BE(5);
        var body = buf.slice(9, 9 + length);
        processFrame(socket, type, flags, streamId, body);
        buf = buf.slice(9 + length);
      }
    }
    mainLoop(socket);

  });
}

function mainLoop(socket) {
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
  var offset = 0;
  var buffer = null;

  socket.on('readable', function() { // assume synchronized & sequencial
    var buf = socket.read();
    if (buffer === null) {
      var frameLength = 9 + (buf.readUInt32BE(0) >> 8); // header + payload
      buffer = new Buffer(frameLength);
    }
    buf.copy(buffer, offset);
    offset += buf.length;
    if (offset >= buffer.length) {
      // console.log(offset, buffer.length);
      var length = buf.readUInt32BE(0) >> 8;
      var type = buffer.readUInt8(3);
      var flags = buffer.readUInt8(4);
      var streamId = buffer.readUInt32BE(5);
      var payload = buffer.slice(9, 9 + length);
      processFrame(socket, type, flags, streamId, payload);
      // console.log(payload.length + 9, buffer.length);
      // reset
      // TODO
      offset = 0;
      buffer = null;
    }
  });

}

function processFrame(socket, type, flags, streamId, payload) {
  console.log();
  console.log('[' + streamId + ']');
  if (type === 0x00) {
    console.log('DATA - not supported');
  } else if (type === 0x01) {
    console.log('HEADERS');
    var headers = readHeaders(flags, payload);
    console.log(headers);
    sendResponse(socket, streamId);
  } else if (type === 0x02) {
    console.log('PRIORITY - not supported');
  } else if (type === 0x03) {
    console.log('RST_STREAM - not supported');
  } else if (type === 0x04) {
    console.log('SETTINGS');
    assert.equal(streamId, 0);
    var ack = !!(flags & 0x1);
    if (!ack) {
      var settings = readSettings(payload);
      console.log(settings);
      sendSettings(socket, settings.maxConcurrentStreams);
    }
  } else if (type === 0x05) {
    console.log('PUSH_PROMISE - not supported');
  } else if (type === 0x06) {
    console.log('PING');
    var ack = !!(flags & 0x1);
    if (!ack) {
      sendPing(socket, streamId, payload);
    }
  } else if (type === 0x07) {
    console.log('GOAWAY - not supported');
  } else if (type === 0x08) {
    console.log('WINDOW_UPDATE - not supported');
    var windowSizeIncrement = payload.readUInt32BE(0);
  } else if (type === 0x09) {
    console.log('CONTINUATION - not supported');
  } else {
    console.log(type, flags, streamId, payload, payload.length);
    assert.fail();
  }
}

function readSettings(payload) {
  var settings = {
    maxConcurrentStreams: 1024
  };
  for (i = 0; i < payload.length; i += 6) {
    var identifier = payload.readUInt16BE(i);
    var value = payload.readUInt32BE(i + 2);
    if (identifier === 0x1) { //SETTINGS_HEADER_TABLE_SIZE 
    } else if (identifier === 0x2) { //SETTINGS_ENABLE_PUSH  
    } else if (identifier === 0x3) { //SETTINGS_MAX_CONCURRENT_STREAMS  
      settings.maxConcurrentStreams = value;
    } else if (identifier === 0x4) { //SETTINGS_INITIAL_WINDOW_SIZE  
    } else if (identifier === 0x5) { //SETTINGS_MAX_FRAME_SIZE  
    } else if (identifier === 0x6) { //SETTINGS_MAX_HEADER_LIST_SIZE  
    } else {
      //ignore
    }
  }
  return settings;
}

function readHeaders(flags, payload) {
  var headers = {};
  var endStream = !!(flags & 0x1);
  var endHeaders = !!(flags & 0x4);
  var padded = !!(flags & 0x8);
  var priority = !!(flags & 0x20);
  var offset = 0;
  offset += padded ? 1 : 0;
  offset += priority ? 5 : 0;
  if (padded) {
    var padLength = payload.readUInt8(0);
    headers.padLength = padLength;
    
  }
  if (priority) {
    var streamDependency = payload.readUInt32BE((padded ? 1 : 0) + 0);
    var weight = payload.readUInt8((padded ? 1 : 0) + 4);
    headers.streamDependency = streamDependency;
    headers.weight = weight;
  }
  var headerBlockFragment = payload.slice(offset); //assume padding does not exist
  var decoder = hpack.createContext();
  var decompressed = decoder.decompress(headerBlockFragment);
  headers.headerBlockFragment = decompressed;
  return headers;
}


function sendSettings(socket, maxConcurrentStreams) {
  // FRAME 1 -----------//
  var streamId = 0;
  var payloadLength = 6 * 4;
  var type = 0x04; //SETTINGS
  var flags = 0x0;
  var buffer = new Buffer(9 + payloadLength);

  // header
  buffer.writeUInt32BE(payloadLength << 8, 0);
  buffer.writeUInt8(type, 3);
  buffer.writeUInt8(flags, 4);
  buffer.writeUInt32BE(streamId, 5);

  // payload
  buffer.writeUInt16BE(0x1, 9); // SETTINGS_HEADER_TABLE_SIZE
  buffer.writeUInt32BE(4096, 11);
  buffer.writeUInt16BE(0x2, 15); // SETTINGS_ENABLE_PUSH
  buffer.writeUInt32BE(1, 17); //true
  buffer.writeUInt16BE(0x3, 21); //SETTINGS_MAX_CONCURRENT_STREAMS
  buffer.writeUInt32BE(maxConcurrentStreams, 23);
  buffer.writeUInt16BE(0x4, 27); // SETTINGS_INITIAL_WINDOW_SIZE
  buffer.writeUInt32BE(65535, 29);
  assert.equal(9 + payloadLength, buffer.length);

  socket.write(buffer);

  // FRAME 2 -----------//
  var streamId = 0;
  var payloadLength = 0;
  var type = 0x04; //SETTINGS
  var flags = 0x1; // ack
  var buffer = new Buffer(9);

  // header
  buffer.writeUInt32BE(payloadLength << 8, 0);
  buffer.writeUInt8(type, 3);
  buffer.writeUInt8(flags, 4);
  buffer.writeUInt32BE(streamId, 5);

  socket.write(buffer);
}


function sendResponse(socket, streamId) {

  // HEADER -------------//
  var encoder = hpack.createContext();
  var headers = [
    [':status', '200']
  ];
  var compressed = encoder.compress(headers);

  var payloadLength = compressed.length;
  var type = 0x01; //HEADERS
  var header = new Buffer(9);

  var flags = 0x4; // end_headers
  // header
  header.writeUInt32BE(payloadLength << 8, 0);
  header.writeUInt8(type, 3);
  header.writeUInt8(flags, 4);
  header.writeUInt32BE(streamId, 5);

  var buffer = Buffer.concat([header, compressed]);
  socket.write(buffer);

  // BODY -------------//
  var data = new Buffer('Hello, World!');

  var payloadLength = data.length;
  var type = 0x00; // DATA
  var header = new Buffer(9);

  var flags = 0x1; // end_stream
  // header
  header.writeUInt32BE(payloadLength << 8, 0);
  header.writeUInt8(type, 3);
  header.writeUInt8(flags, 4);
  header.writeUInt32BE(streamId, 5);

  var buffer = Buffer.concat([header, data]);
  socket.write(buffer);
}

function sendPing(socket, streamId, payload) {
  var header = new Buffer(9);
  var payloadLength = 8;
  var type = 0x06; // PING
  var flags = 0x1; // ack

  var buffer = new Buffer(9 + payloadLength);
  buffer.writeUInt32BE(payloadLength << 8, 0);
  buffer.writeUInt8(type, 3);
  buffer.writeUInt8(flags, 4);
  buffer.writeUInt32BE(streamId, 5);
  payload.copy(buffer, 9);

  socket.write(buffer);
}

function sendGoAway(socket, streamId) {
  var header = new Buffer(9);
  var payloadLength = 8;
  var type = 0x07; // GOAWAY
  var flags = 0x0;

  var lastStreamId = streamId; // ?
  var errorCode = 0;

  var buffer = new Buffer(9 + payloadLength);

  buffer.writeUInt32BE(payloadLength << 8, 0);
  buffer.writeUInt8(type, 3);
  buffer.writeUInt8(flags, 4);
  buffer.writeUInt32BE(streamId, 5);
  //
  buffer.writeUInt32BE(lastStreamId, 9);
  buffer.writeUInt32BE(errorCode, 13);

  socket.end(buffer);
}

