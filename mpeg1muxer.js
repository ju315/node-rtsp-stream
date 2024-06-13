const child_process = require('child_process')
const util = require('util')
const events = require('events')

const Mpeg1Muxer = function(options) {
  this.url = options.url;
  this.useUdp = options.useUdp;
  this.ffmpegOptions = options.ffmpegOptions;
  this.name = options.name;
  this.exitCode = undefined;
  this.additionalFlags = [];
  this.logger = options.logger;

  if (this.ffmpegOptions) {
    for (const key in this.ffmpegOptions) {
      this.additionalFlags.push(key)
      if (String(this.ffmpegOptions[key]) !== '') {
        this.additionalFlags.push(String(this.ffmpegOptions[key]))
      }
    }
  }

  // TOPView 실행 옵션: [rtsp_transport=tcp, allowed_media_types=video, max_delay=500000, stimeout=5000000]
  // 해당 옵션은 Stream 시작할때 ffmpegOptions 값으로 전달.

  this.spawnOptions = [
    this.url,
    '-b:v', '1000k',

    // '-maxrate', '1000k',
    // '-bufsize', '1000k',

    // max bitrate possibly too small or try trellis with large lmax or increase qmax 경고 메세지로 인해 옵션 추가.
    // '-qmin', '16',
    // '-qmax', '51',

    '-an',

    // additional ffmpeg options go here
    ...this.additionalFlags,
    '-'
  ];

  if (this.useUdp) {
    this.spawnOptions.unshift('-i');
  } else {
    this.spawnOptions.unshift(...['-rtsp_transport', 'tcp', '-i']);
  }

  this.stream = child_process.spawn(options.ffmpegPath, this.spawnOptions, {
    detached: false
  });

  this.inputStreamStarted = true;
  global.Logger && global.Logger.debug(`node-rtsp-stream(${this.name}):: ffmpeg stream start command ${JSON.stringify(this.spawnOptions)}`);
  this.logger && this.logger.debug(`node-rtsp-stream(${this.name}):: ffmpeg stream start command ${JSON.stringify(this.spawnOptions)}`);

  this.stream.stdout.on('data', (data) => {
    return this.emit('mpeg1data', data);
  });

  this.stream.stderr.on('data', (data) => {
    return this.emit('ffmpegStderr', data);
  });

  this.stream.on('exit', (code, signal) => {
    global.Logger && global.Logger.error(`node-rtsp-stream(${this.name}):: ffmpeg Stream on Exit Code. (code: ${code}, signal: ${signal})`);
    this.logger && this.logger.error(`node-rtsp-stream(${this.name}):: ffmpeg Stream on Exit Code. (code: ${code}, signal: ${signal})`);

    if (code === 1) {
      global.Logger && global.Logger.error(`node-rtsp-stream(${this.name}):: RTSP stream exited with error`)
      this.logger && this.logger.error(`node-rtsp-stream(${this.name}):: RTSP stream exited with error`)

      this.exitCode = 1
      return this.emit('exitWithError');
    }

    if (signal === 'SIGTERM') {
      return this.emit('exitWithError');
    }
  });

  return this;
}

Mpeg1Muxer.prototype.close = function() {
  this.stream.stdin.write('q');
  this.stream.kill();
  delete this.stream;
  this.inputStreamStarted = false;

  global.Logger && global.Logger.info(`node-rtsp-stream(${this.name}):: ffmpeg RTSP stream has stopped and destroyed.`);
  this.logger && this.logger.info(`node-rtsp-stream(${this.name}):: ffmpeg RTSP stream has stopped and destroyed.`);
}

util.inherits(Mpeg1Muxer, events.EventEmitter)

module.exports = Mpeg1Muxer
