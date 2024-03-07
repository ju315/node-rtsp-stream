const child_process = require('child_process')
const util = require('util')
const events = require('events')

const Mpeg1Muxer = function(options) {
  this.url = options.url;
  this.useTcp = options.useTcp;
  this.ffmpegOptions = options.ffmpegOptions;
  this.exitCode = undefined;
  this.additionalFlags = [];

  if (this.ffmpegOptions) {
    for (const key in this.ffmpegOptions) {
      this.additionalFlags.push(key)
      if (String(this.ffmpegOptions[key]) !== '') {
        this.additionalFlags.push(String(this.ffmpegOptions[key]))
      }
    }
  }

  this.spawnOptions = [
    this.url,
    '-b:v', '1000k',
    '-maxrate', '1000k',
    '-bufsize', '1000k',
    // max bitrate possibly too small or try trellis with large lmax or increase qmax 경고 메세지로 인해 옵션 추가.
    '-qmin', '16',
    '-qmax', '51',
    '-an',
    // additional ffmpeg options go here
    ...this.additionalFlags,
    '-'
  ];

  if (this.useTcp) {
    this.spawnOptions.unshift(...['-rtsp_transport', 'tcp', '-i']);
  }
  else {
    this.spawnOptions.unshift('-i');
  }

  this.stream = child_process.spawn(options.ffmpegPath, this.spawnOptions, {
    detached: false
  });

  this.inputStreamStarted = true;

  this.stream.stdout.on('data', (data) => {
    return this.emit('mpeg1data', data);
  });

  this.stream.stderr.on('data', (data) => {
    return this.emit('ffmpegStderr', data);
  });

  this.stream.on('exit', (code, signal) => {
    global.Logger.info(`node-rtsp-stream:: ffmpeg Stream on Exit Code. (code: ${code}, signal: ${signal})`);
    if (code === 1) {
      global.Logger.error('node-rtsp-stream:: RTSP stream exited with error')
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
  global.Logger.info('node-rtsp-stream:: RTSP stream has stopped and destroyed.');
}

util.inherits(Mpeg1Muxer, events.EventEmitter)

module.exports = Mpeg1Muxer
