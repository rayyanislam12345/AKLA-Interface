// Runs in the AudioWorkletGlobalScope. Converts incoming Float32 audio
// samples to 16-bit PCM chunks and posts them back to the main thread.
class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._chunkSize = 4096; // ~256ms at 16kHz
  }

  process(inputs) {
    const channelData = inputs[0]?.[0];
    if (channelData) {
      for (let i = 0; i < channelData.length; i++) {
        this._buffer.push(channelData[i]);
      }
      while (this._buffer.length >= this._chunkSize) {
        const chunk = this._buffer.splice(0, this._chunkSize);
        const int16 = new Int16Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(int16.buffer, [int16.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorderProcessor);
