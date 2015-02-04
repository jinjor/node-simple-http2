var fs = require('fs');
var tls = require('tls');
var assert = require('assert');
var hpack = require('./sasazka/lib/hpack.js');

var SETTINGS_MAX_FRAME_SIZE = 16384;
var CLIENT_PRELUDE = new Buffer('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

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
    console.log('closed');
  });
  socket.on('error', function(err) {
    console.log(err.stack);
  });
  if (socket.npnProtocol === 'h2-14' || socket.npnProtocol === 'h2-16') {
    start(socket);
  } else {
    assert.fail('socket.npnProtocol:' + socket.npnProtocol);
  }
});
server.listen(8443);

function start(socket) {
  var context = {
    compressor: hpack.createContext(),
    decompressor: hpack.createContext(),
    streams: [true]
  };
  socket.once('readable', function() {
    var buf = socket.read();
    if(!buf) {
      console.log('buf is null');
      return;
    }
    for (var i = 0; i < CLIENT_PRELUDE.length; i++) {
      if (buf[i] !== CLIENT_PRELUDE[i]) {
        console.log(buf.toString());
        socket.end();//TODO send GOAWAY 0x1かも（3.5）
        return;
      }
    }
    console.log('Successfully received the client connection header prelude.');
    mainLoop(socket, context, buf.slice(CLIENT_PRELUDE.length));
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

  var read = function(buf) {

    buf = Buffer.concat([prev, buf]);
    while (buf.length > 0) {
      var length = buf.readUInt32BE(0) >> 8;
      var type = buf.readUInt8(3);
      var flags = buf.readUInt8(4);
      var streamId = buf.readUInt32BE(5);
      if(buf.length >= 9 + length) {
        var body = buf.slice(9, 9 + length);
        processFrame(socket, context, type, flags, streamId, body);
        buf = buf.slice(9 + length);
      } else {
        break;
      }
    }
    prev = buf;
  }
  read(buf);

  socket.on('readable', function() { // assume synchronized & sequencial
    var buf = socket.read();
    if(!buf) {
      return;
      // throw 'buff is null';
    }
    read(buf);
  });

}

function processFrame(socket, context, type, flags, streamId, payload) {
  // console.log();
  console.log('[' + streamId + ']');
  //3.5
  if(payload.length > 16384) {
    sendGoAway(socket, streamId, 0x6);
    return;
  }
  //5.1.1
  if(streamId >= 2 && streamId % 2 === 0 && context.streams[streamId] === undefined) {
    sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
    return;
  }
  //5.1.1
  if(streamId < context.streams.length - 1 && context.streams[streamId] === undefined) {
    sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
    return;
  }

  //6.2
  if(context.continuationStreamId) {
    if(type !== 0x09) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    if(context.continuationStreamId !== streamId) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    context.continuationStreamId = null;
  }


  
  context.streams[streamId] = context.streams[streamId] || 1;//idle?


  var count = 0;
  for(var i = 0; i < context.streams.length; i++) {
    if(context.streams[i]) {
      count++;
    }
  }
  if(context.settings && count > context.settings.maxConcurrentStreams) {
    // console.log(count, context.settings.maxConcurrentStreams)
    sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
    return;
  }




  if (type === 0x00) {
    console.log('DATA - not supported');
    if(streamId === 0) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    if(context.streams[streamId] !== 2) {
      sendGoAway(socket, streamId, 0x5);//STREAM_CLOSED
      return;
    }
  } else if (type === 0x01) {
    console.log('HEADERS');
    if(streamId === 0) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    var headers = readHeaders(context, flags, payload);

    //8.1.2
    var containsUpperCase = false;
    var keys = Object.keys(headers.data);
    for(var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if(key.toLowerCase() !== key) {
        containsUpperCase = true;
        break;
      }
    }
    if(containsUpperCase) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }

    //8.1.2.1
    var containsInvalidPseudoFields = false;
    var keys = Object.keys(headers.data);
    for(var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if(key[0] === ':') {
        if(key !== ':method' && key !== ':scheme' && key !== ':authority' && key !== ':path') {
          containsInvalidPseudoFields = true;
          break;
        }
      }
    }
    if(containsInvalidPseudoFields) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }

    //8.1.2.1
    var invalidFieldOrder = false;
    for(var i = 0; i < headers.headerBlockFragment.length; i++) {
      var pair = headers.headerBlockFragment[i];
      if(pair[0][0] === ':' && headers.headerBlockFragment[i - 1] && headers.headerBlockFragment[i - 1][0][0] !== ':') {
        invalidFieldOrder = true;
        break;
      }
    }
    if(invalidFieldOrder) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }

    //8.1.2.2
    if(headers.data.connection) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }

    //8.1.2.2
    if(headers.data.te && headers.data.te !== 'trailers') {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }

    //8.1.2.3
    if(!headers.data[':method'] || !headers.data[':scheme'] || !headers.data[':path']) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }

    //8.1.2.6
    if(headers.data['content-length'] && +headers.data['content-length'] !== payload.length) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    
    if(headers.endHeaders) {
      context.streams[streamId] = 2;//open
    } else {
      context.continuationStreamId = streamId;
    }
    console.log(headers);
    // sendResponseHTML(socket, context, streamId, headers);
    sendResponseHTMLWithPush(socket, context, streamId, headers);
  } else if (type === 0x02) {
    console.log('PRIORITY - not supported');
    if(streamId === 0) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    if(payload.length !== 5) {
      sendGoAway(socket, streamId, 0x6);//FRAME_SIZE_ERROR
      return;
    }
    readPriority(flags, payload);
  } else if (type === 0x03) {
    console.log('RST_STREAM - not supported');
    if(streamId === 0) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    if(context.streams[streamId] === 1) {//idle
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    if(payload.length !== 4) {
      sendGoAway(socket, streamId, 0x6);//FRAME_SIZE_ERROR
      return;
    }
  } else if (type === 0x04) {
    console.log('SETTINGS');
    if(streamId !== 0) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    var ack = !!(flags & 0x1);
    if(ack) {
      if(payload.length !== 0) {
        sendGoAway(socket, streamId, 0x6);//FRAME_SIZE_ERROR
        return;
      }
    } else {
      if(payload.length % 6 !== 0) {
        sendGoAway(socket, context.streams.length - 1, 0x6);//FRAME_SIZE_ERROR
        return;
      }
      var settings = readSettings(payload);
      context.settings = settings;//TODO これでいいのか確認
      sendSettings(socket, settings.maxConcurrentStreams);
    }
  } else if (type === 0x05) {
    console.log('PUSH_PROMISE');
    sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
    return;
  } else if (type === 0x06) {
    console.log('PING');
    if(streamId !== 0) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    if(payload.length !== 8) {
      sendGoAway(socket, streamId, 0x6);//FRAME_SIZE_ERROR
      return;
    }
    var ack = !!(flags & 0x1);
    if (!ack) {
      sendPing(socket, streamId, payload);
    }
  } else if (type === 0x07) {
    console.log('GOAWAY - not supported');
    if(streamId !== 0) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
  } else if (type === 0x08) {
    console.log('WINDOW_UPDATE - not supported');
    var windowSizeIncrement = payload.readUInt32BE(0);
    if(windowSizeIncrement === 0) {
      sendGoAway(socket, streamId, 0x1);//PROTOCOL_ERROR
      return;
    }
    if(payload.length % 4 !== 0) {
      sendGoAway(socket, context.streams.length - 1, 0x6);//FRAME_SIZE_ERROR
      return;
    }
  } else if (type === 0x09) {
    console.log('CONTINUATION - not supported');
  } else {
    console.log(type, flags, streamId, payload, payload.length);
    assert.fail();
  }
}

function readSettings(payload) {
  var settings = {
    headerTableSize: 4096,
    enablePush: 1,
    maxConcurrentStreams: 1024
  };
  for (i = 0; i < payload.length; i += 6) {
    var identifier = payload.readUInt16BE(i);
    var value = payload.readUInt32BE(i + 2);
    if (identifier === 0x1) { //SETTINGS_HEADER_TABLE_SIZE 
      settings.headerTableSize = value;
    } else if (identifier === 0x2) { //SETTINGS_ENABLE_PUSH
      settings.enablePush = value;
    } else if (identifier === 0x3) { //SETTINGS_MAX_CONCURRENT_STREAMS
      settings.maxConcurrentStreams = value;
    } else if (identifier === 0x4) { //SETTINGS_INITIAL_WINDOW_SIZE
      settings.initialWindowSize = value;
    } else if (identifier === 0x5) { //SETTINGS_MAX_FRAME_SIZE
      settings.maxFrameSize = value;
    } else if (identifier === 0x6) { //SETTINGS_MAX_HEADER_LIST_SIZE
      settings.maxHeaderListSize = value;
    } else {
      //ignore
    }
  }
  return settings;
}

function readHeaders(context, flags, payload) {
  var headers = {};
  var endStream = !!(flags & 0x1);
  headers.endHeaders = !!(flags & 0x4);
  var padded = !!(flags & 0x8);
  var priority = !!(flags & 0x20);
  var offset = 0;
  offset += padded ? 1 : 0;
  offset += priority ? 5 : 0;
  if (padded) {
    var padLength = payload.readUInt8(0);
    headers.padLength = padLength;
  }
  // console.log(endStream, endHeaders);
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


function sendSettings(socket, maxConcurrentStreams) {
  // FRAME 1 -----------//
  var streamId = 0;
  var payloadLength = 6 * 4;
  var type = 0x04; //SETTINGS
  var flags = 0x0;
  var buffer = new Buffer(9 + payloadLength);

  // header
  writeHeader(buffer, payloadLength, type, flags, streamId);

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
  writeHeader(buffer, payloadLength, type, flags, streamId);

  socket.write(buffer);
}

function sendResponseHTML(socket, context, streamId, requestHeaders, noHTML) {

  var path = requestHeaders.data[':path'];
  if (path === '/') {
    path = 'index.html';
  } else {
    path = path.substring(1);
  }

  // HEADER -------------//
  var headers = [];
  headers[0] = [':status', '200'];
  if (!noHTML) {
    headers[1] = ['content-type', 'text/html'];
  } else {
    headers[1] = [':path', '/app.css'];
    headers[2] = ['content-type', 'text/css'];
  }
  var compressed = context.compressor.compress(headers);

  var payloadLength = compressed.length;
  var type = 0x01; //HEADERS
  var header = new Buffer(9);

  var flags = 0x4; // end_headers
  // header
  writeHeader(header, payloadLength, type, flags, streamId);

  var buffer = Buffer.concat([header, compressed]);
  socket.write(buffer);

  // BODY -------------//
  var data = new Buffer(fs.readFileSync(path));

  var payloadLength = data.length;
  var type = 0x00; // DATA
  var header = new Buffer(9);

  var flags = 0x1; // end_stream
  // header
  writeHeader(header, payloadLength, type, flags, streamId);

  var buffer = Buffer.concat([header, data]);
  socket.write(buffer);
}


function sendResponseHTMLWithPush(socket, context, streamId, requestHeaders) {

  var path = requestHeaders.data[':path'];
  if (path === '/') {
    path = 'index.html';
  } else {
    path = path.substring(1);
  }
  console.log(path);

  if (path === 'index.html') {
    // PUSH_PROMISE -------------//
    var headers = [];
    requestHeaders.headerBlockFragment.forEach(function(header) {
      if (header[0] === ':path') {
        headers.push([':path', '/app.css']);
      } else {
        headers.push(header);
      }
    });

    var compressedResponseHeader = context.compressor.compress(headers);

    var payloadLength = compressedResponseHeader.length + 4;
    var type = 0x05; // PUSH_PROMISE
    var buffer = new Buffer(9 + payloadLength);
    var flags = 0x4; // end_headers
    writeHeader(buffer, payloadLength, type, flags, streamId);

    var promisedStreamId = 4;
    context.streams[promisedStreamId] = true;//TODO


    buffer.writeUInt32BE(promisedStreamId, 9);
    compressedResponseHeader.copy(buffer, 9 + 4);
    socket.write(buffer);
    console.log('send PUSH_PROMISE');

    sendResponseHTML(socket, context, promisedStreamId, {
      data: {
        ':path': '/app.css'
      }
    }, true);
    sendResponseHTML(socket, context, streamId, requestHeaders);
  } else {
    assert.fail();
  }

}



function sendPing(socket, streamId, payload) {
  var header = new Buffer(9);
  var payloadLength = 8;
  var type = 0x06; // PING
  var flags = 0x1; // ack

  var buffer = new Buffer(9 + payloadLength);
  writeHeader(buffer, payloadLength, type, flags, streamId);
  payload.copy(buffer, 9);

  socket.write(buffer);
}

function sendGoAway(socket, lastStreamId, errorCode) {
  console.log('send goaway: ' + errorCode);
  var header = new Buffer(9);
  var payloadLength = 8;
  var type = 0x07; // GOAWAY
  var flags = 0x0;

  var buffer = new Buffer(9 + payloadLength);

  writeHeader(buffer, payloadLength, type, flags, 0);
  //
  buffer.writeUInt32BE(lastStreamId, 9);
  buffer.writeUInt32BE(errorCode, 13);
  socket.write(buffer);
}

function writeHeader(buffer, length, type, flags, streamId) {
  buffer.writeUInt32BE(length << 8, 0);
  buffer.writeUInt8(type, 3);
  buffer.writeUInt8(flags, 4);
  buffer.writeUInt32BE(streamId, 5);
}