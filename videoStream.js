const ws = require('ws')
const util = require('util')
const events = require('events')
const Mpeg1Muxer = require('./mpeg1muxer')
const STREAM_MAGIC_BYTES = "jsmp" // Must be 4 bytes

const VideoStream = function(options) {
  this.options = options;
  this.name = options.name;
  this.streamUrl = options.streamUrl;
  this.width = options.width;
  this.height = options.height;
  this.wsPort = options.wsPort;
  this.wsHost = options.wsHost;
  this.inputStreamStarted = false;
  this.stream = undefined;
  this.wsClient = [];
  this.ffmpegTimer = null;
  this.maxTimeGap = options.maxTimeGap || 30000;

  global.Logger.info(`node-rtsp-stream:: Init VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`);
  this.startMpeg1Stream();
  this.pipeStreamToSocketServer();
  return this
}

util.inherits(VideoStream, events.EventEmitter)

VideoStream.prototype.stop = function() {
  global.Logger.error(`node-rtsp-stream:: Stop VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`);
  if (this.wsClient.length) {
    for (const client of this.wsClient) {
      client.send('socket will be closed');
      client.close();
    }
  }

  clearInterval(this.ffmpegTimer);
  this.mpeg1Muxer.close();
  this.inputStreamStarted = false;
  return this;
}

VideoStream.prototype.restart = function() {
  global.Logger.info(`node-rtsp-stream:: Restart VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`);
  this.startMpeg1Stream();
}

VideoStream.prototype.getClientCount = function() {
  return this.wsServer.clients.size;
}

VideoStream.prototype.startMpeg1Stream = function() {
  let gettingInputData, gettingOutputData, inputData, outputData, lastUtc;

  this.mpeg1Muxer = new Mpeg1Muxer({
    ffmpegOptions: this.options.ffmpegOptions,
    url: this.streamUrl,
    ffmpegPath: this.options.ffmpegPath == undefined ? "ffmpeg" : this.options.ffmpegPath,
    useTcp: this.options.useTcp,
  });

  this.stream = this.mpeg1Muxer.stream;

  if (this.inputStreamStarted) {
    return;
  }

  lastUtc = new Date().getTime();

  this.mpeg1Muxer.on('mpeg1data', (data) => {
    const nowDate = new Date().getTime();
    lastUtc = nowDate;

    return this.emit('camdata', data)
  });

  gettingInputData = false;
  inputData = [];
  gettingOutputData = false;
  outputData = [];

  this.mpeg1Muxer.on('ffmpegStderr', (data) => {
    const nowDate = new Date().getTime();
    lastUtc = nowDate;

    let size;
    data = data.toString();

    if (data.indexOf('Input #') !== -1) {
      gettingInputData = true;
    }

    if (data.indexOf('Output #') !== -1) {
      gettingInputData = false;
      gettingOutputData = true;
    }

    if (data.indexOf('frame') === 0) {
      gettingOutputData = false;
    }

    if (gettingInputData) {
      inputData.push(data.toString());
      size = data.match(/\d+x\d+/);
      if (size != null) {
        size = size[0].split('x');
        if (this.width == null) {
          this.width = parseInt(size[0], 10);
        }
        if (this.height == null) {
          return this.height = parseInt(size[1], 10);
        }
      }
    }
  });

  this.mpeg1Muxer.on('ffmpegStderr', function(data) {
    return global.process.stderr.write(data);
  });

  this.mpeg1Muxer.on('exitWithError', () => {
    global.Logger.error(`node-rtsp-stream:: ${this.name} ffmpeg get exitWithError.`);

    return this.emit('exitWithError');
  });

  this.ffmpegTimer = setInterval(() => {
    const nowUtc = new Date().getTime();

    if (nowUtc < lastUtc + this.maxTimeGap) return;

    global.Logger.error(`node-rtsp-stream:: The stream is terminated because no stream data has been received for a certain period of time. (name: ${this.name}, ms: ${this.maxTimeGap})`);

    clearInterval(this.ffmpegTimer);
    this.stop();
  }, this.maxTimeGap);

  return this;
}

VideoStream.prototype.pipeStreamToSocketServer = function() {
  try {
    this.wsServer = new ws.Server({
      port: this.wsPort,
      host: this.wsHost,
    });

    this.wsServer.on("connection", (socket, request) => {
      this.wsClient.push(socket);
      return this.onSocketConnect(socket, request)
    });

    this.wsServer.broadcast = function(data, opts) {
      let results = [];
      for (let client of this.clients) {
        if (client.readyState === 1) {
          results.push(client.send(data, opts));
        } else {
          global.Logger.error(`node-rtsp-stream:: Error. Client from remoteAddress ${client.remoteAddress} not connected.`);
          results.push(console.log("Error: Client from remoteAddress " + client.remoteAddress + " not connected."))
        }
      }
      return results;
    }

    return this.on('camdata', (data) => {
      return this.wsServer.broadcast(data)
    });
  } catch (err) {
    global.Logger.error(`node-rtsp-stream:: ${this.name} broadcast Socket something went wrong.(err: ${err.message})`);
    console.log('something went wrong...');
    console.log(err);
  }
}

VideoStream.prototype.onSocketConnect = function(socket, request) {
  // Send magic bytes and video size to the newly connected socket
  // struct { char magic[4]; unsigned short width, height;}
  const streamHeader = Buffer.alloc(8);
  streamHeader.write(STREAM_MAGIC_BYTES);
  streamHeader.writeUInt16BE(this.width, 4);
  streamHeader.writeUInt16BE(this.height, 6);
  socket.send(streamHeader, {
    binary: true
  });

  const clientIp = request.headers["x-forwarded-for"] || request.connection.remoteAddress;
  global.Logger.info(`node-rtsp-stream:: ${this.name}: New WebSocket Connection. (clientIp: ${clientIp}, total: ${this.wsServer.clients.size})`);

  socket.remoteAddress = request.connection.remoteAddress;

  return socket.on("close", (code, message) => {
    global.Logger.info(`node-rtsp-stream:: ${this.name}: Disconnected WebSocket. (clientIp: ${clientIp}, code: ${code}, message: ${message || null}, total: ${this.wsServer.clients.size})`);
    return console.log(`${this.name}: Disconnected WebSocket (${this.wsServer.clients.size} total)`);
  })
}

module.exports = VideoStream;
