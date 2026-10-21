const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const config = require('../config/videoConversion');

function invalid(message = 'Não foi possível ler este vídeo ou o formato/codec não é suportado') {
  const error = new Error(message);
  error.status = 400;
  return error;
}
function ratio(value) {
  const [a, b = 1] = String(value || '0').split(/[/:]/).map(Number);
  return b ? a / b : 0;
}
function dimensions(width, height, mode) {
  if (!['preserve', '720p'].includes(mode)) throw invalid('Resolução inválida.');
  const scale = mode === 'preserve' ? 1 : Math.min(1, 1280 / Math.max(width, height), 720 / Math.min(width, height));
  const w = Math.floor(width * scale / 2) * 2;
  const h = Math.floor(height * scale / 2) * 2;
  if (w < 2 || h < 2 || Math.abs((w / h) / (width / height) - 1) > .01) {
    throw invalid('Não é possível obter dimensões pares com erro de proporção ≤ 1%.');
  }
  return { width: w, height: h };
}
function validateSize(size, type) {
  const limit = config.limits[type];
  if (!limit) throw invalid('Perfil sem acesso à conversão.');
  if (!Number.isSafeInteger(size) || size <= 0 || size > limit.bytes) {
    throw invalid(`Tamanho de entrada: ${size} bytes; limite: ${limit.bytes} bytes.`);
  }
}
function inspect(probe, size, type, output = false) {
  validateSize(size, type);
  const streams = probe.streams || [];
  const videos = streams.filter(s => s.codec_type === 'video');
  const audios = streams.filter(s => s.codec_type === 'audio');
  if (videos.length !== 1 || audios.length > 1 || streams.length !== videos.length + audios.length) throw invalid();
  const v = videos[0], a = audios[0];
  const container = probe.format?.format_name || '';
  const webm = container.includes('webm') && v.codec_name === 'vp9';
  const mp4 = container.includes('mov') && v.codec_name === 'h264';
  if ((!webm && !mp4) || (a && a.codec_name !== (webm ? 'opus' : 'aac'))) throw invalid();
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > config.limits[type].seconds + (output ? .5 : 0)) {
    throw invalid(`Duração de entrada: ${duration}s; limite: ${config.limits[type].seconds}s.`);
  }
  const rotation = ((Number(v.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation)) throw invalid('Rotação não suportada.');
  const fps = ratio(v.avg_frame_rate);
  if (!fps || fps > 30.001 || Math.abs(fps - ratio(v.r_frame_rate)) > .02) throw invalid('A conversão exige taxa constante até 30 fps.');
  const times = (probe.frames || []).filter(f => f.media_type === 'video').map(f => Number(f.best_effort_timestamp_time));
  if (times.length < 1 || times.some((t, i) => !Number.isFinite(t) || (i > 0 && Math.abs(t - times[i - 1] - 1 / fps) > .002))) {
    throw invalid('A conversão exige taxa constante até 30 fps.');
  }

  if (!v.width || !v.height) {
  throw invalid(`Dimensões ausentes ou inválidas: ${v.width}x${v.height}`);
  }

  if (v.width % 2 !== 0 || v.height % 2 !== 0) {
    throw invalid(`As dimensões têm de ser pares. Atual: ${v.width}x${v.height}`);
  }

  if (Math.max(v.width, v.height) > 1920) {
    throw invalid(
      `O lado maior excede 1920px. Atual: ${Math.max(v.width, v.height)}px`
    );
  }

  if (Math.min(v.width, v.height) > 1080) {
    throw invalid(
      `O lado menor excede 1080px. Atual: ${Math.min(v.width, v.height)}px`
    );
  }

  const pixelRatio = ratio(v.sample_aspect_ratio);
  if (pixelRatio !== 1 && pixelRatio !== 0 && pixelRatio !== undefined) {
  throw invalid(
    `Exige píxeis quadrados (sample_aspect_ratio 1:1). Atual: ${v.sample_aspect_ratio} (rácio: ${pixelRatio})`
  );
}
  if (['smpte2084', 'arib-std-b67'].includes(v.color_transfer) || v.side_data_list?.some(s => /mastering|content light/i.test(s.side_data_type))) {
    throw invalid('A conversão aceita apenas vídeo SDR.');
  }
  if (a && ![1, 2].includes(a.channels)) throw invalid('O áudio deve ser mono ou estéreo.');
  const turned = rotation === 90 || rotation === 270;
  return { duration, width: turned ? v.height : v.width, height: turned ? v.width : v.height,
    videoCodec: v.codec_name, audioCodec: a?.codec_name || 'none', channels: a?.channels || 0, fps, rotation, container: webm ? 'webm' : 'mp4/mov' };
}
// Never invokes a shell. Abort kills ffprobe/ffmpeg immediately, including validation.
function run(binary, args, { signal, onProgress, maxBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '', progressBuffer = '', failure;
    const abort = () => { failure = signal.reason || new Error('Interrompido'); child.kill('SIGKILL'); };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => {
      if (onProgress) {
        progressBuffer += data.toString();
        const lines = progressBuffer.split('\n'); progressBuffer = lines.pop();
        for (const line of lines) if (line.startsWith('out_time_us=')) onProgress(Number(line.slice(12)) / 1e6);
      } else {
        output += data;
        if (Buffer.byteLength(output) > maxBytes) { failure = invalid(); child.kill('SIGKILL'); }
      }
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.on('error', e => { failure = e; });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(failure || new Error(`${binary}: ${stderr}`));
      else resolve(output);
    });
  });
}
// ffprobe reports both Matroska and WebM as "matroska,webm". The EBML
// DocType distinguishes an actual WebM from a renamed MKV with the same codecs.
function isWebmHeader(header) {
  if (header.length < 8 || header.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const tag = header.indexOf(Buffer.from([0x42, 0x82]), 4);
  if (tag < 0 || tag + 2 >= header.length) return false;
  let mask = 0x80, bytes = 1;
  while (bytes <= 8 && !(header[tag + 2] & mask)) { mask >>= 1; bytes++; }
  if (bytes > 8 || tag + 2 + bytes + 4 > header.length) return false;
  let length = header[tag + 2] & (mask - 1);
  for (let i = 1; i < bytes; i++) length = length * 256 + header[tag + 2 + i];
  return length === 4 && header.subarray(tag + 2 + bytes, tag + 2 + bytes + 4).toString('ascii') === 'webm';
}
async function probe(file, signal) {
  const result = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-show_frames',
    '-show_entries', 'frame=media_type,best_effort_timestamp_time:stream:format', '-of', 'json', file], { signal }));
  if (result.format?.format_name?.includes('webm')) {
    const handle = await fs.open(file, 'r');
    try {
      const header = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (!isWebmHeader(header.subarray(0, bytesRead))) throw invalid();
    } finally { await handle.close(); }
  }
  return result;
}
function argumentsFor(input, output, source, target, resolution) {
  if (!config.profiles[target]) throw invalid('Perfil de destino inválido.');
  const d = dimensions(source.width, source.height, resolution);
  const args = ['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0', '-vf', `scale=${d.width}:${d.height},setsar=1`,
    '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-threads', '2'];
  if (target === 'mp4') args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
  else args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '96k');
  args.push('-progress', 'pipe:1', '-nostats', '-y', output);
  return args;
}
function validateOutput(probeData, source, target, resolution, size) {
  // Output can be larger than the input allowance: check its technical profile separately.
  const actual = inspect(probeData, 1, 'premium', true);
  const d = dimensions(source.width, source.height, resolution), p = config.profiles[target];
  if (!size || actual.videoCodec !== p.video || actual.audioCodec !== (source.channels ? p.audio : 'none') ||
      actual.channels !== source.channels || actual.rotation !== 0 || actual.width !== d.width || actual.height !== d.height ||
      Math.abs(actual.fps - source.fps) > .02 || Math.abs(actual.duration - source.duration) > .5) throw invalid('O vídeo convertido não passou a validação');
  return { ...actual, rotation: 0 };
}
module.exports = { isWebmHeader, invalid, inspect, probe, run, argumentsFor, dimensions, validateSize, validateOutput };
