class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.bufferSize = 0;
    this.targetSamples = 1600; // 100ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.buffer.push(input[i]);
    }
    this.bufferSize += input.length;

    if (this.bufferSize >= this.targetSamples) {
      const int16 = new Int16Array(this.bufferSize);
      for (let i = 0; i < this.bufferSize; i++) {
        const s = Math.max(-1, Math.min(1, this.buffer[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      this.port.postMessage(
        { audioData: int16.buffer, streamType: 'tab' },
        [int16.buffer]
      );

      this.buffer = [];
      this.bufferSize = 0;
    }

    return true;
  }
}
registerProcessor('pcm-processor-tab', PCMProcessor);
