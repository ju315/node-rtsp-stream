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
  this.logger = options.logger || null;

  /**
   * logger 정보.
   * this.logger: NestJS의 logger 객체
   * global.Logger: express의 global logger 객체
  */
  global.Logger && global.Logger.info(`node-rtsp-stream(${this.name}):: Init VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`);
  this.logger && this.logger.log(`node-rtsp-stream(${this.name}):: Init VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`)

  this.startMpeg1Stream();
  this.pipeStreamToSocketServer();
  return this
}

util.inherits(VideoStream, events.EventEmitter)

VideoStream.prototype.stop = function() {
  global.Logger && global.Logger.error(`node-rtsp-stream(${this.name}):: Stop VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`);
  this.logger && this.logger.error(`node-rtsp-stream(${this.name}):: Stop VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`);

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
  global.Logger && global.Logger.info(`node-rtsp-stream(${this.name}):: Restart VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`);
  this.logger && this.logger.log(`node-rtsp-stream(${this.name}):: Restart VideoStream. (name: ${this.name}, streamUrl: ${this.streamUrl}, ws: ${this.wsHost}:${this.wsPort})`);

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
    useUdp: this.options.useUdp,
    name: this.name,
    logger: this.logger,
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
    const msg = data.toString();

    if (msg.includes('frame=')) {
      process.env.NODE_ENV && global.process.stderr.write(data);
      return;
    }

    process.env.NODE_ENV && global.process.stderr.write(data);
    if (msg.includes('Past duration')) return;

    global.Logger && global.Logger.debug(`node-rtsp-stream(${this.name}):: ${msg}`)
    this.logger && this.logger.debug(`node-rtsp-stream(${this.name}):: ${msg}`)

    return;
  });

  this.mpeg1Muxer.on('exitWithError', () => {
    global.Logger && global.Logger.error(`node-rtsp-stream(${this.name}):: ${this.name} ffmpeg get exitWithError.`);
    this.logger && this.logger.error(`node-rtsp-stream(${this.name}):: ${this.name} ffmpeg get exitWithError.`);

    clearInterval(this.ffmpegTimer);

    return this.emit('exitWithError');
  });

  this.ffmpegTimer = setInterval(() => {
    const nowUtc = new Date().getTime();

    if (nowUtc < lastUtc + this.maxTimeGap) return;

    global.Logger && global.Logger.error(`node-rtsp-stream(${this.name}):: The stream is terminated because no stream data has been received for a certain period of time. (name: ${this.name}, ms: ${this.maxTimeGap})`);
    this.logger && this.logger.error(`node-rtsp-stream(${this.name}):: The stream is terminated because no stream data has been received for a certain period of time. (name: ${this.name}, ms: ${this.maxTimeGap})`);

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
          global.Logger && global.Logger.error(`node-rtsp-stream(${this.name}):: Error. Client from remoteAddress ${client.remoteAddress} not connected.`);
          this.logger && this.logger.error(`node-rtsp-stream(${this.name}):: Error. Client from remoteAddress ${client.remoteAddress} not connected.`);

          results.push(console.log("Error: Client from remoteAddress " + client.remoteAddress + " not connected."))
        }
      }
      return results;
    }

    return this.on('camdata', (data) => {
      return this.wsServer.broadcast(data)
    });
  } catch (err) {
    global.Logger && global.Logger.error(`node-rtsp-stream(${this.name}):: ${this.name} broadcast Socket something went wrong.(err: ${err.message})`);
    this.logger && this.logger.error(`node-rtsp-stream(${this.name}):: ${this.name} broadcast Socket something went wrong.(err: ${err.message})`);

    console.log('something went wrong...');
    console.log(err);
  }
}

VideoStream.prototype.onSocketConnect = function(socket, request) {
  // Send magic bytes and video size to the newly connected socket
  // struct { char magic[4]; unsigned short width, height;}
  if (!this.width || !this.height) {
    // width, height는 stream 정보에서 받아오고 있음.
    // 아직 width, height값이 정의되지 않으면 stream이 생성되지 않았으므로 socket 종료.
    global.Logger && global.Logger.error(`node-rtsp-stream(${this.name}):: Stream information for ffmpeg has not been created yet. Send socket close signal.`);
    this.logger && this.logger.error(`node-rtsp-stream(${this.name}):: Stream information for ffmpeg has not been created yet. Send socket close signal.`)

    socket.send('socket will be closed');
    socket.close();
    return;
  }

  const streamHeader = Buffer.alloc(8);
  streamHeader.write(STREAM_MAGIC_BYTES);
  streamHeader.writeUInt16BE(this.width, 4);
  streamHeader.writeUInt16BE(this.height, 6);
  socket.send(streamHeader, {
    binary: true
  });

  const clientIp = request.headers["x-forwarded-for"] || request.connection.remoteAddress;
  global.Logger && global.Logger.info(`node-rtsp-stream(${this.name}):: ${this.name}: New WebSocket Connection. (clientIp: ${clientIp}, total: ${this.wsServer.clients.size})`);
  this.logger && this.logger.log(`node-rtsp-stream(${this.name}):: ${this.name}: New WebSocket Connection. (clientIp: ${clientIp}, total: ${this.wsServer.clients.size})`);

  socket.remoteAddress = request.connection.remoteAddress;

  return socket.on("close", (code, message) => {
    global.Logger && global.Logger.info(`node-rtsp-stream(${this.name}):: ${this.name}: Disconnected WebSocket. (clientIp: ${clientIp}, code: ${code}, message: ${message || null}, total: ${this.wsServer.clients.size})`);
    this.logger && this.logger.log(`node-rtsp-stream(${this.name}):: ${this.name}: Disconnected WebSocket. (clientIp: ${clientIp}, code: ${code}, message: ${message || null}, total: ${this.wsServer.clients.size})`);

    return;
  })
}

module.exports = VideoStream;
