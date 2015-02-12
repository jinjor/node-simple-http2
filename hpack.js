var huffman = require('./huffman');

var STATIC_TABLE = [
  [],
  [':authority', ''],
  [':method', 'GET'],
  [':method', 'POST'],
  [':path', '/'],
  [':path', '/index.html'],
  [':scheme', 'http'],
  [':scheme', 'https'],
  [':status', '200'],
  [':status', '204'],
  [':status', '206'],
  [':status', '304'],
  [':status', '400'],
  [':status', '404'],
  [':status', '500'],
  ['accept-charset', ''],
  ['accept-encoding', 'gzip, deflate'],
  ['accept-language', ''],
  ['accept-ranges', ''],
  ['accept', ''],
  ['access-control-allow-origin', ''],
  ['age', ''],
  ['allow', ''],
  ['authorization', ''],
  ['cache-control', ''],
  ['content-disposition', ''],
  ['content-encoding', ''],
  ['content-language', ''],
  ['content-length', ''],
  ['content-location', ''],
  ['content-range', ''],
  ['content-type', ''],
  ['cookie', ''],
  ['date', ''],
  ['etag', ''],
  ['expect', ''],
  ['expires', ''],
  ['from', ''],
  ['host', ''],
  ['if-match', ''],
  ['if-modified-since', ''],
  ['if-none-match', ''],
  ['if-range', ''],
  ['if-unmodified-since', ''],
  ['last-modified', ''],
  ['link', ''],
  ['location', ''],
  ['max-forwards', ''],
  ['proxy-authenticate', ''],
  ['proxy-authorization', ''],
  ['range', ''],
  ['referer', ''],
  ['refresh', ''],
  ['retry-after', ''],
  ['server', ''],
  ['set-cookie', ''],
  ['strict-transport-security', ''],
  ['transfer-encoding', ''],
  ['user-agent', ''],
  ['vary', ''],
  ['via', ''],
  ['www-authenticate', '']
];
var staticTableMap = {};
STATIC_TABLE.forEach(function(pair, index) {
  staticTableMap[pair[0]] = staticTableMap[pair[0]] || {
    index: index,
    values: {}
  };
  staticTableMap[pair[0]].values[pair[1]] = true;
});



function decodeNumber(octets, n) {
  var x = Math.pow(2, n);
  if (octets[0] % x === x - 1) {
    var sum = x - 1;
    for (var i = 1; i < octets.length; i++) {
      var octet = octets[i];
      if (!!(octet & 0x80)) {
        sum += (octet % x) + Math.pow(128, i - 1);
      } else {
        sum += octet + Math.pow(128, i - 1);
        break;
      }
    }
    console.log(i + 1);
    return [sum, i + 1];
  } else {
    return [octets[0] % x, 1];
  }
}

function encodeNumber(number, n) {
  var limit = Math.pow(2, n) - 1;
  if (number > limit) {
    number = number - limit;
    var octets = [limit];
    while (true) {
      var r = number % 128;
      var q = (number - r) / 128;
      if (q > 0) {
        octets.push(r + 128);
        number = q;
      } else {
        octets.push(r);
        break;
      }
    }
    return new Buffer(octets);
  } else {
    return new Buffer([number]);
  }
}


function getByIndex(context, index) {
  if (index === 0) {
    throw 'error';
  }
  if (index >= STATIC_TABLE.length) {
    return context.dynamicTable[index - STATIC_TABLE.length];
  } else {
    return STATIC_TABLE[index];
  }
}

function updateDynamicTable(context, name, value) {
  context.dynamicTable.unshift([name, value]);
  fixTableSize(context);
}

function fixTableSize(context) {
  context.dynamicTable.length = Math.min(context.dynamicTable.length, context.maxTableSize);
}

function encode(context, header, useHuffman) {
  var bufs = header.map(function(pair) {
    var name = pair[0];
    var value = pair[1];
    var index = null;
    var indexedValue = false;
    if (staticTableMap[name]) {
      index = staticTableMap[name].index;
      if (staticTableMap[name].values[value]) {
        indexedValue = true;
      }
    }
    var header = 0;
    if (index && indexedValue) {
      var indexBuffer = encodeNumber(index, 7);
      indexBuffer[0] |= 0x80;
      return indexBuffer;
    } else if (index) {
      var indexBuffer = encodeNumber(index, 6);
      indexBuffer[0] |= 0x40;
      var encodedString = huffman.encode(value);
      var length = encodeNumber(encodedString.length, 7);
      length[0] |= 0x80; //H
      return Buffer.concat([indexBuffer, length, encodedString]);
    } else {
      var indexBuffer = new Buffer(1);
      indexBuffer[0] |= 0x40;
      var encodedName = huffman.encode(name);
      var nameLength = encodeNumber(encodedName.length, 7);
      nameLength[0] |= 0x80; //H
      var encodedValue = huffman.encode(value);
      var valueLength = encodeNumber(encodedValue.length, 7);
      valueLength[0] |= 0x80; //H
      return Buffer.concat([indexBuffer, nameLength, encodedName, valueLength, encodedValue]);
    }
  });
  return Buffer.concat(bufs);
}

function decode(context, buf, result) {
  var header = buf[0];
  var length = null;
  if (!!(header & 0x80)) { //インデックスヘッダフィールド表現
    var type = ' ';
    var num = decodeNumber(buf, 7);
    index = num[0];
    //6.1
    if (index === 0) {
      throw 'error';
    }
    console.log('(_)', type, index, getByIndex(context, index));

    result.push(getByIndex(context, index));
    buf = buf.slice(num[1]);
  } else if (!(header & 0x80) && !(header & 0x40) && !!(header & 0x20)) { //動的テーブルサイズ更新
    var num = decodeNumber(buf, 5);
    context.maxTableSize = num[0];
    fixTableSize(context);
    buf = buf.slice(num[1]);
  } else {
    var indexDecodeN = 0;
    var type = ' ';
    if (!(header & 0x80) && !!(header & 0x40)) { //インデックス更新を伴うリテラルヘッダフィールド
      type = 'A';
      if (header % 0x40 !== 0) { //インデックスされた名前
        indexDecodeN = 6;
      }
    } else if (header >> 4 === 0) { //インデックス更新を伴わないリテラルヘッダフィールド
      type = 'B';
      if (header % 0x10 !== 0) { //インデックスされた名前
        indexDecodeN = 4;
      }
    } else if (!(header & 0x80) && !(header & 0x40)　 && !(header & 0x20)　 && !!(header & 0x10)) { //インデックスされないリテラルヘッダフィールド
      type = 'C';
      if (header % 0x10 !== 0) { //インデックスされた名前
        indexDecodeN = 4;
      }
    }

    if (indexDecodeN) {
      var num = decodeNumber(buf, indexDecodeN);
      var index = num[0];
      if (index === 0) {
        throw 'index is zero';
      }
      var headerLength = num[1];
      buf = buf.slice(headerLength);

      var huffmaned = !!(buf[0] & 0x80);
      num = decodeNumber(buf, 7);
      var valueLengthLength = num[1];
      var valueLength = num[0];

      buf = buf.slice(valueLengthLength);

      var value = buf.slice(0, valueLength);
      if (huffmaned) {
        value = huffman.decode(value);
      } else {
        value = value.toString();
      }
      var name = getByIndex(context, index)[0]
      if (type === 'A') {
        updateDynamicTable(context, name, value);
      }

      console.log('(a)', type, index, getByIndex(context, index), valueLength, huffmaned, value);

      result.push([name, value]);

      buf = buf.slice(valueLength);
    } else {
      buf = buf.slice(1);

      var nameHuffmaned = !!(buf[0] & 0x80);
      var num = decodeNumber(buf, 7);
      var nameLengthLength = num[1];
      var nameLength = num[0];

      buf = buf.slice(nameLengthLength);

      var name = buf.slice(0, nameLength);
      if (nameHuffmaned) {
        name = huffman.decode(name);
      } else {
        name = value.toString();
      }

      buf = buf.slice(nameLength);

      var valueHuffmaned = !!(buf[0] & 0x80);
      var num = decodeNumber(buf, 7);
      var valueLengthLength = num[1];
      var valueLength = num[0];

      buf = buf.slice(valueLengthLength);

      var value = buf.slice(0, valueLength);
      if (valueHuffmaned) {
        value = huffman.decode(value);
      } else {
        value = value.toString();
      }
      if (type === 'A') {
        updateDynamicTable(context, name, value);
      }

      console.log('(b)', type, nameHuffmaned, name, valueHuffmaned, value);

      result.push([name, value]);

      buf = buf.slice(valueLength);
    }
  }
  return buf;
}

module.exports = function(maxTableSize) {
  var context = {
    dynamicTable: [],
    maxTableSize: maxTableSize
  };
  return {
    encode: function(header) {
      return encode(context, header, true); //TODO
    },
    decode: function(buf) {
      try {
        var result = [];
        while (buf.length) {
          buf = decode(context, buf, result);
        }
        return result;
      } catch (e) {

        console.log(e.trace);
      }
    }
  };
};