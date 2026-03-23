import re

with open('/root/proyect/clarin/frontend/src/components/dynamics/ScratchCard.tsx', 'r') as f:
    content = f.read()

old_audio = """  // ----- Audio Setup -----
  const initAudio = useCallback(() => {
    if (audioCtxRef.current) return;
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    audioCtxRef.current = ctx;

    // Create scratch noise (white noise buffer)
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 3000;
    bandpass.Q.value = 0.5;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(ctx.destination);
    source.start();

    scratchNoiseRef.current = source;
    scratchGainRef.current = gain;
  }, []);

  const setScratchVolume = useCallback((speed: number) => {
    if (!scratchGainRef.current) return;
    const vol = Math.min(speed / 300, 0.4);
    scratchGainRef.current.gain.setTargetAtTime(vol, audioCtxRef.current!.currentTime, 0.01);
  }, []);

  const stopScratchSound = useCallback(() => {
    if (!scratchGainRef.current) return;
    scratchGainRef.current.gain.setTargetAtTime(0, audioCtxRef.current!.currentTime, 0.05);
  }, []);"""

new_audio = """  const scratchFilterRef = useRef<BiquadFilterNode | null>(null);

  // ----- Audio Setup -----
  const initAudio = useCallback(() => {
    if (audioCtxRef.current) {
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      return;
    }
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    audioCtxRef.current = ctx;

    // Create scratch noise (texture/grainy noise buffer)
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      // brown noise approximation for texture
      data[i] = (lastOut + (0.05 * white)) / 1.05;
      lastOut = data[i];
      // Boost volume and add grit
      data[i] *= 4.5; 
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    // Use a peaking filter to simulate the resonant freq of scratching paper/cardboard
    const peaking = ctx.createBiquadFilter();
    peaking.type = 'peaking';
    peaking.frequency.value = 1500;
    peaking.Q.value = 1.5;
    peaking.gain.value = 5;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(peaking);
    peaking.connect(gain);
    gain.connect(ctx.destination);
    source.start();

    scratchFilterRef.current = peaking;
    scratchNoiseRef.current = source;
    scratchGainRef.current = gain;
  }, []);

  const setScratchVolume = useCallback((speed: number) => {
    if (!scratchGainRef.current || !audioCtxRef.current) return;
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    
    // Closer target time, sharper attack
    const now = audioCtxRef.current.currentTime;
    
    // Scale volume based on speed, with a cap
    const vol = Math.min(speed / 100, 0.8) + 0.1;
    scratchGainRef.current.gain.setTargetAtTime(vol, now, 0.02);

    // Modulate the filter frequency slightly based on speed for dynamic texture
    if (scratchFilterRef.current) {
        const freq = 1200 + Math.min(speed * 10, 2000);
        scratchFilterRef.current.frequency.setTargetAtTime(freq, now, 0.02);
    }
  }, []);

  const stopScratchSound = useCallback(() => {
    if (!scratchGainRef.current || !audioCtxRef.current) return;
    scratchGainRef.current.gain.setTargetAtTime(0, audioCtxRef.current.currentTime, 0.1);
  }, []);"""

content = content.replace(old_audio, new_audio)

with open('/root/proyect/clarin/frontend/src/components/dynamics/ScratchCard.tsx', 'w') as f:
    f.write(content)

