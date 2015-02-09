var huffman = require('./huffman');

// <----------  Index Address Space ---------->
// <-- Static  Table -->  <-- Dynamic Table -->
// +---+-----------+---+  +---+-----------+---+
// | 1 |    ...    | s |  |s+1|    ...    |s+k|
// +---+-----------+---+  +---+-----------+---+
//                        ^                   |
//                        |                   V
//                 Insertion Point      Dropping Point


// SETTINGS_HEADER_TABLE_SIZEで動的テーブルのサイズが決まる

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
    console.log(i+1);
    return [sum, i + 1];
  } else {
    return [octets[0] % x, 1];
  }
}

function decodeString(context, buf) {

  console.log(buf[0]);


}


function decode(context, buf) {
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
    console.log('(_)', type, index, STATIC_TABLE[index]);
    buf = buf.slice(num[1]);
  } else if (!(header & 0x80) && !(header & 0x40) && !!(header & 0x20)) { //動的テーブルサイズ更新
    var num = decodeNumber(buf, 5);
    var maxSize = num[0];
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

      var huffmaned = !!(buf[0] && 0x80);
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
      console.log('(a)', type, index, STATIC_TABLE[index], valueLength, huffmaned, value);

      buf = buf.slice(valueLength);
    } else {
      buf = buf.slice(1);

      var nameHuffmaned = !!(buf[0] && 0x80);
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

      var valueHuffmaned = !!(buf[0] && 0x80);
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

      console.log('(b)', type, nameHuffmaned, name, valueHuffmaned, value);

      buf = buf.slice(valueLength);
    }
  }
  return buf;
}


function updateIndex(context, buf) {


}



module.exports = function() {
  var context = {};
  return {
    encode: function(buf) {
      decode(context, buf);
    },
    decode: function(buf) {
      try {
        while (buf.length) {
          buf = decode(context, buf);
        }
      } catch (e) {
        console.log(e);
      }

    }
  };
};