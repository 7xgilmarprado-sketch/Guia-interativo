import React, { useState, useRef, useEffect } from 'react';
import { Camera, Mic, Square, AlertTriangle, Loader2, Activity } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

class AudioStreamer {
  audioCtx: AudioContext;
  nextPlayTime: number;
  activeSources: AudioBufferSourceNode[] = [];

  constructor() {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    try {
      this.audioCtx = new AudioContextClass({ sampleRate: 24000 });
    } catch (e) {
      this.audioCtx = new AudioContextClass();
    }
    this.nextPlayTime = this.audioCtx.currentTime;
  }

  playPcm16(base64: string) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }

    const buffer = this.audioCtx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);
    
    source.onended = () => {
      this.activeSources = this.activeSources.filter(s => s !== source);
    };
    this.activeSources.push(source);

    const startTime = Math.max(this.nextPlayTime, this.audioCtx.currentTime);
    source.start(startTime);
    this.nextPlayTime = startTime + buffer.duration;
  }

  interrupt() {
    this.activeSources.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    this.activeSources = [];
    this.nextPlayTime = this.audioCtx.currentTime;
  }

  stop() {
    this.interrupt();
    if (this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
    }
  }
}

const SYSTEM_PROMPT = `Você é um assistente de acessibilidade para pessoas cegas.
Você está recebendo um fluxo de vídeo contínuo da câmera do celular do usuário e áudio do microfone.

Regras CRÍTICAS:
1. Você será solicitado a descrever o ambiente frequentemente.
2. Quando solicitado, responda com no MÁXIMO UMA FRASE CURTA E DIRETA. Exemplo: "Caminho livre", "Cadeira à direita", "Pessoa se aproximando de frente".
3. Priorize informações de segurança e navegação (degraus, portas, buracos, pessoas).
4. Diga a posição dos objetos (à esquerda, direita, frente).
5. Nunca use jargões visuais complexos, seja prático.
6. Se o usuário fizer uma pergunta específica pelo microfone, responda a pergunta de forma clara e concisa.`;

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string>('');
  
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const startAssistant = async () => {
    setIsConnecting(true);
    setError('');

    try {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error("A chave da API do Gemini (GEMINI_API_KEY) não está configurada.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: true
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      audioStreamerRef.current = new AudioStreamer();

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: SYSTEM_PROMPT,
        },
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsActive(true);
            
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            let audioCtx: AudioContext;
            try {
              audioCtx = new AudioContextClass({ sampleRate: 16000 });
            } catch (e) {
              audioCtx = new AudioContextClass();
            }

            const source = audioCtx.createMediaStreamSource(stream);
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);

            processor.onaudioprocess = (e) => {
              const float32 = e.inputBuffer.getChannelData(0);
              const pcm16 = new Int16Array(float32.length);
              
              // Verifica se o assistente está falando no momento
              const isSpeaking = audioStreamerRef.current && audioStreamerRef.current.activeSources.length > 0;

              for (let i = 0; i < float32.length; i++) {
                // Se estiver falando, envia silêncio (0) para não interromper. Caso contrário, envia o áudio do microfone.
                pcm16[i] = isSpeaking ? 0 : Math.max(-1, Math.min(1, float32[i])) * 32767;
              }
              const bytes = new Uint8Array(pcm16.buffer);
              let binary = '';
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              const base64 = btoa(binary);
              
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  media: { data: base64, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };

            source.connect(processor);
            processor.connect(audioCtx.destination);

            const videoInterval = setInterval(() => {
              if (videoRef.current && canvasRef.current) {
                const video = videoRef.current;
                const canvas = canvasRef.current;
                if (video.videoWidth === 0) return;
                
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                  const base64Image = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
                  
                  sessionPromise.then(session => {
                    session.sendRealtimeInput({
                      media: { data: base64Image, mimeType: 'image/jpeg' }
                    });

                    // Solicita a descrição automaticamente a cada 2 segundos,
                    // mas apenas se o assistente não estiver falando no momento,
                    // para evitar que os áudios se atropelem.
                    if (audioStreamerRef.current && audioStreamerRef.current.activeSources.length === 0) {
                      (session as any).send({
                        clientContent: {
                          turns: [{
                            role: "user",
                            parts: [{ text: "Descreva o que está na minha frente agora em uma frase muito curta." }]
                          }],
                          turnComplete: true
                        }
                      });
                    }
                  });
                }
              }
            }, 2000);

            cleanupRef.current = () => {
              clearInterval(videoInterval);
              processor.disconnect();
              source.disconnect();
              if (audioCtx.state !== 'closed') audioCtx.close();
              stream.getTracks().forEach(t => t.stop());
              sessionPromise.then(session => session.close());
              if (audioStreamerRef.current) {
                audioStreamerRef.current.stop();
              }
            };
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioStreamerRef.current) {
              audioStreamerRef.current.playPcm16(base64Audio);
            }
            if (message.serverContent?.interrupted && audioStreamerRef.current) {
              audioStreamerRef.current.interrupt();
            }
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setError(`Erro na conexão: ${err.message || "Falha ao comunicar com o assistente."}`);
            stopAssistant();
          },
          onclose: () => {
            stopAssistant();
          }
        }
      });

      sessionPromise.catch(err => {
        console.error("Live API Connection Error:", err);
        setError(`Erro ao conectar: ${err.message || "Falha ao iniciar sessão com o Gemini."}`);
        stopAssistant();
      });

    } catch (err: any) {
      console.error("Setup error:", err);
      setError(`Erro: ${err.message || "Não foi possível iniciar o assistente."}`);
      setIsConnecting(false);
    }
  };

  const stopAssistant = () => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    setIsActive(false);
    setIsConnecting(false);
  };

  useEffect(() => {
    return () => {
      stopAssistant();
    };
  }, []);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col font-sans">
      <header className="p-4 bg-zinc-900 flex justify-between items-center border-b border-zinc-800">
        <h1 className="text-xl font-bold">Assistente de Visão</h1>
        {isActive && (
          <div className="flex items-center gap-2 text-emerald-500 bg-emerald-500/10 px-3 py-1.5 rounded-full">
            <Activity size={18} className="animate-pulse" />
            <span className="text-sm font-medium">Ativo</span>
          </div>
        )}
      </header>

      <main className="flex-1 flex flex-col relative">
        <div className="relative flex-1 bg-zinc-950 overflow-hidden">
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline 
            muted 
            className="absolute inset-0 w-full h-full object-cover opacity-60"
          />
          <canvas ref={canvasRef} className="hidden" />
          
          <div className="absolute inset-0 flex flex-col justify-end p-6 bg-gradient-to-t from-black via-black/60 to-transparent">
            {error && (
              <div className="bg-red-900/80 border border-red-500 text-white p-4 rounded-xl mb-4 flex items-start gap-3">
                <AlertTriangle className="shrink-0 mt-1" />
                <p className="text-lg font-medium">{error}</p>
              </div>
            )}
            
            {isActive && !error && (
              <div className="bg-zinc-900/90 backdrop-blur-md border border-zinc-700 text-white p-5 rounded-2xl mb-4 flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
                  <Mic className="text-emerald-500 animate-pulse" size={24} />
                </div>
                <div>
                  <p className="text-lg font-medium">Ouvindo e observando...</p>
                  <p className="text-zinc-400 text-sm">Pode fazer perguntas ou apenas apontar a câmera.</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="p-6 bg-zinc-900 pb-12">
          {!isActive ? (
            <button
              onClick={startAssistant}
              disabled={isConnecting}
              className={`w-full py-8 rounded-3xl flex flex-col items-center justify-center gap-4 transition-all active:scale-95 ${
                isConnecting 
                  ? 'bg-zinc-700 text-zinc-400' 
                  : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg shadow-emerald-900/50'
              }`}
              aria-label="Iniciar Assistente"
            >
              {isConnecting ? (
                <>
                  <Loader2 size={48} className="animate-spin" />
                  <span className="text-2xl font-bold">Conectando...</span>
                </>
              ) : (
                <>
                  <Camera size={48} />
                  <span className="text-3xl font-bold tracking-tight">Iniciar Assistente</span>
                </>
              )}
            </button>
          ) : (
            <button
              onClick={stopAssistant}
              className="w-full py-8 rounded-3xl flex flex-col items-center justify-center gap-4 transition-all active:scale-95 bg-red-600 text-white hover:bg-red-500 shadow-lg shadow-red-900/50"
              aria-label="Parar Assistente"
            >
              <Square size={48} fill="currentColor" />
              <span className="text-3xl font-bold tracking-tight">Parar Assistente</span>
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
