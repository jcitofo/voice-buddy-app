
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Difficulty, SessionStats, Scenario, ChatMessage } from './types';
import { SYSTEM_PROMPT, SCENARIOS } from './constants';
import { decodeBase64, decodeAudioData, createPcmBlob } from './utils/audio';
import StatsCard from './components/StatsCard';

const App: React.FC = () => {
  // State
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sourceMaterial, setSourceMaterial] = useState<string>('');
  const [isKnowledgeBaseOpen, setIsKnowledgeBaseOpen] = useState(false);
  const [stats, setStats] = useState<SessionStats>({
    turns: 0,
    words: 0,
    startTime: new Date(),
    feedbackCount: 0,
  });
  const [difficulty, setDifficulty] = useState<Difficulty>(Difficulty.NORMAL);
  const [currentScenario, setCurrentScenario] = useState<Scenario | null>(null);

  // Audio Contexts & Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Transcriptions buffer
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  // Auto-reconnect refs
  const shouldAutoReconnect = useRef(false);
  const currentScenarioRef = useRef<Scenario | null>(null);
  const startSessionRef = useRef<(scenario?: Scenario, isReconnect?: boolean) => Promise<void>>();

  // Auto scroll to bottom of chat
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const stopAudio = useCallback(() => {
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const handleStopSession = useCallback(() => {
    shouldAutoReconnect.current = false; // User manually stopped — no reconnect
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    setIsActive(false);
    stopAudio();
    if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
    if (outputAudioContextRef.current) { outputAudioContextRef.current.close(); outputAudioContextRef.current = null; }
  }, [stopAudio]);

  const handleReset = useCallback(() => {
    if (window.confirm("Do you want to clear all messages, statistics and course materials?")) {
      handleStopSession();
      setMessages([]);
      setSourceMaterial('');
      setCurrentScenario(null);
      setDifficulty(Difficulty.NORMAL);
      setStats({
        turns: 0,
        words: 0,
        startTime: new Date(),
        feedbackCount: 0,
      });
    }
  }, [handleStopSession]);

  const startSession = useCallback(async (scenario?: Scenario, isReconnect = false) => {
    setIsConnecting(true);
    if (!isReconnect) {
      setMessages([]);
      setStats({
          turns: 0,
          words: 0,
          startTime: new Date(),
          feedbackCount: 0,
      });
    } else {
      // Add a visual separator so the user knows the session was renewed
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: '🔄 Session renewed automatically — continuing your practice!',
        timestamp: new Date(),
      }]);
    }
    shouldAutoReconnect.current = true;
    currentScenarioRef.current = scenario ?? null;
    
    try {
      const ai = new GoogleGenAI({ apiKey: (import.meta as any).env.VITE_API_KEY });
      
      // Initialize Audio Contexts
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 1. Prepare Greeting Text
      let greetingText = "";
      if (sourceMaterial) {
          greetingText = "Hello! I've reviewed your course materials. I'm ready to help you practice English using those specific topics. What part of the lesson should we focus on today?";
      } else {
          greetingText = scenario 
            ? `Hi there! Let's practice ${scenario.topic}. I'm ready to play the role of the ${scenario.id === 'coffee' ? 'barista' : scenario.id === 'restaurant' ? 'waiter' : scenario.id === 'interview' ? 'interviewer' : 'partner'}. How can I help you?`
            : "Hello! I'm VoiceBuddy, your English conversation partner. I'm excited to practice with you today. How are you doing?";
      }

      // 2. Pre-generate Greeting Audio via TTS
      const greetingResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: greetingText }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
      });

      const base64Greeting = greetingResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      // 3. Construct System Instruction with Source Material
      let instruction = scenario 
        ? `${SYSTEM_PROMPT}\n\nCURRENT SCENARIO: ${scenario.prompt}`
        : SYSTEM_PROMPT;

      if (sourceMaterial) {
          instruction += `\n\nKNOWLEDGE BASE / SOURCE MATERIAL PROVIDED BY STUDENT:\n${sourceMaterial}\n\nINSTRUCTION: The user has provided specific course material. Focus your English practice and questions around this content to help them study while practicing English conversation.`;
      }

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: instruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: async () => {
            setIsConnecting(false);
            setIsActive(true);

            // Play initial greeting audio
            if (base64Greeting && outputAudioContextRef.current) {
              const greetingBuffer = await decodeAudioData(
                decodeBase64(base64Greeting),
                outputAudioContextRef.current,
                24000,
                1
              );
              
              const greetingSource = outputAudioContextRef.current.createBufferSource();
              greetingSource.buffer = greetingBuffer;
              greetingSource.connect(outputAudioContextRef.current.destination);
              greetingSource.start(0);
              
              setMessages([{ role: 'assistant', text: greetingText, timestamp: new Date() }]);
              nextStartTimeRef.current = outputAudioContextRef.current.currentTime + greetingBuffer.duration;
            }
            
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const audioBuffer = await decodeAudioData(
                decodeBase64(base64Audio),
                outputAudioContextRef.current,
                24000,
                1
              );
              
              const source = outputAudioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioContextRef.current.destination);
              
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }

            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const userText = currentInputTranscription.current;
              const assistantText = currentOutputTranscription.current;
              
              if (userText) {
                setMessages(prev => [...prev, { role: 'user', text: userText, timestamp: new Date() }]);
              }
              if (assistantText) {
                setMessages(prev => [...prev, { role: 'assistant', text: assistantText, timestamp: new Date() }]);
                setStats(prev => ({
                    ...prev,
                    turns: prev.turns + 1,
                    words: prev.words + assistantText.split(' ').length,
                    feedbackCount: assistantText.toLowerCase().includes('pronounce') ? prev.feedbackCount + 1 : prev.feedbackCount
                }));
              }
              
              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
            }

            if (message.serverContent?.interrupted) {
              stopAudio();
            }
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            handleStopSession();
          },
          onclose: () => {
            setIsActive(false);
            stopAudio();
            if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
            if (outputAudioContextRef.current) { outputAudioContextRef.current.close(); outputAudioContextRef.current = null; }
            // Auto-reconnect if session was closed by server (not by user)
            if (shouldAutoReconnect.current) {
              setTimeout(() => {
                startSessionRef.current?.(currentScenarioRef.current ?? undefined, true);
              }, 2000);
            }
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (error) {
      console.error("Failed to start session:", error);
      setIsConnecting(false);
    }
  }, [handleStopSession, stopAudio, sourceMaterial]);

  // Keep ref in sync so onclose can always call the latest startSession
  startSessionRef.current = startSession;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col w-full">
      {/* Container fluide plein écran */}
      <div className="flex-1 flex flex-col w-full max-w-[1800px] mx-auto px-4 py-4 md:px-6 md:py-6 gap-6">
        
        {/* En-tête adaptatif */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-5 md:p-6 rounded-2xl shadow-sm border border-slate-100">
          <div>
            <h1 className="text-3xl font-extrabold text-slate-900 flex items-center gap-2">
              <span className="text-blue-600">Voice</span>Buddy
            </h1>
            <p className="text-slate-500 font-medium">Your interactive AI English language tutor</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
              {/* Bouton RESET bien visible */}
              <button 
                onClick={handleReset}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all border border-slate-200 hover:border-red-100"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Reset App
              </button>

              <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-200">
                <select 
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value as Difficulty)}
                    className="bg-transparent px-3 py-1 text-sm font-semibold text-slate-700 outline-none cursor-pointer"
                >
                    <option value={Difficulty.SLOW}>Slow Pace</option>
                    <option value={Difficulty.NORMAL}>Normal Pace</option>
                    <option value={Difficulty.FAST}>Fast Pace</option>
                </select>
              </div>
              
              {isActive ? (
                  <button 
                      onClick={handleStopSession}
                      className="bg-red-500 hover:bg-red-600 text-white px-8 py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-red-100 flex items-center gap-3 active:scale-95"
                  >
                      <span className="w-2.5 h-2.5 bg-white rounded-full animate-pulse" />
                      End Session
                  </button>
              ) : (
                  <button 
                      disabled={isConnecting}
                      onClick={() => startSession()}
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white px-8 py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-blue-100 active:scale-95"
                  >
                      {isConnecting ? 'Connecting...' : 'Start Practice'}
                  </button>
              )}
          </div>
        </header>

        {/* Statistiques en ligne */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatsCard 
              label="Turns" 
              value={stats.turns} 
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>} 
          />
          <StatsCard 
              label="Words" 
              value={stats.words} 
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5h12M9 3v2m1.048 9.5a18.022 18.022 0 01-3.827-2.002m0 0A18.022 18.022 0 013.843 5.378M9.048 12.5a18.022 18.022 0 003.827-2.002m0 0a18.022 18.022 0 003.857-7.12M9.048 12.5L7.525 17.5M9.048 12.5H7.525M11 5h6M11 5v2m1.535 4.56c-.506 1.49-1.212 2.898-2.087 4.192l-2.43 4.495m-3.414-4.495l2.43-4.495" /></svg>} 
          />
          <StatsCard 
              label="Feedback" 
              value={stats.feedbackCount} 
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} 
          />
          <StatsCard 
              label="Session Time" 
              value={`${Math.floor((new Date().getTime() - stats.startTime.getTime()) / 60000)}m`} 
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} 
          />
        </div>

        {/* Mise en page principale flexible */}
        <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">
          
          {/* Barre latérale (Options et Cours) */}
          <aside className="w-full lg:w-[350px] flex flex-col gap-6 order-2 lg:order-1 shrink-0">
              
              {/* Base de connaissances */}
              <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
                  <button 
                    onClick={() => setIsKnowledgeBaseOpen(!isKnowledgeBaseOpen)}
                    className="w-full flex items-center justify-between text-lg font-bold text-slate-900 group"
                  >
                      <span className="flex items-center gap-3">
                        <div className="bg-blue-50 p-2 rounded-lg group-hover:bg-blue-100 transition-colors">
                          <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                        </div>
                        Course Material
                      </span>
                      <svg className={`w-5 h-5 transition-transform duration-300 ${isKnowledgeBaseOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                  </button>
                  
                  {(isKnowledgeBaseOpen || sourceMaterial) && (
                    <div className="mt-5 space-y-4">
                        <p className="text-sm text-slate-500">Paste your CNED or NotebookLM content here. VoiceBuddy will use it to guide the lesson.</p>
                        <textarea
                            disabled={isActive || isConnecting}
                            value={sourceMaterial}
                            onChange={(e) => setSourceMaterial(e.target.value)}
                            placeholder="Paste text here..."
                            className="w-full h-44 p-4 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none resize-none disabled:bg-slate-50 font-medium"
                        />
                        {sourceMaterial && (
                          <button onClick={() => setSourceMaterial('')} className="text-xs font-bold text-red-500 hover:underline">Clear Materials</button>
                        )}
                    </div>
                  )}
              </section>

              {/* Scénarios de pratique */}
              <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex-1 overflow-y-auto min-h-0">
                  <h3 className="text-lg font-bold text-slate-900 mb-5 flex items-center gap-2">
                    <div className="bg-emerald-50 p-2 rounded-lg">
                      <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
                    </div>
                    Quick Scenarios
                  </h3>
                  <div className="space-y-3">
                      {SCENARIOS.map(s => (
                          <button
                              key={s.id}
                              disabled={isActive || isConnecting}
                              onClick={() => { setCurrentScenario(s); startSession(s); }}
                              className={`w-full flex items-center gap-4 p-3.5 rounded-xl border transition-all text-left group
                                  ${currentScenario?.id === s.id && isActive 
                                      ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-100' 
                                      : 'border-slate-100 hover:border-blue-200 hover:bg-slate-50 disabled:opacity-50'
                                  }`}
                          >
                              <span className="text-2xl group-hover:scale-110 transition-transform">{s.icon}</span>
                              <div className="flex-1 min-w-0">
                                  <p className="text-sm font-bold text-slate-800 truncate">{s.title}</p>
                                  <p className="text-xs text-slate-500 font-medium truncate">Roleplay {s.topic}</p>
                              </div>
                          </button>
                      ))}
                      <button
                          onClick={() => { setCurrentScenario(null); startSession(); }}
                          className="w-full mt-2 p-3 text-sm text-blue-600 font-bold hover:bg-blue-50 rounded-xl transition-all disabled:opacity-50 border border-transparent hover:border-blue-100"
                          disabled={isActive || isConnecting}
                      >
                          Free Conversation
                      </button>
                  </div>
              </section>
          </aside>

          {/* Zone de conversation principale (élargie) */}
          <main className="flex-1 flex flex-col order-1 lg:order-2 min-h-[500px]">
              <div className="bg-white rounded-3xl shadow-sm border border-slate-100 flex-1 flex flex-col overflow-hidden">
                  
                  {/* En-tête du journal */}
                  <div className="bg-slate-50/50 p-5 border-b border-slate-100 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-2.5 h-2.5 rounded-full bg-blue-500"></div>
                        <span className="text-sm font-bold text-slate-700 uppercase tracking-widest">Live Practice Log</span>
                      </div>
                      
                      {isActive && (
                          <div className="flex items-center gap-4">
                            <span className="text-xs font-bold text-blue-600 animate-pulse uppercase">Mic Active</span>
                            <div className="wave-animation">
                                <div className="wave-bar bg-blue-400" style={{animationDelay: '0s'}}></div>
                                <div className="wave-bar bg-blue-500" style={{animationDelay: '0.1s'}}></div>
                                <div className="wave-bar bg-blue-600" style={{animationDelay: '0.2s'}}></div>
                                <div className="wave-bar bg-blue-500" style={{animationDelay: '0.3s'}}></div>
                                <div className="wave-bar bg-blue-400" style={{animationDelay: '0.4s'}}></div>
                            </div>
                          </div>
                      )}
                  </div>

                  {/* Bulles de texte */}
                  <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth">
                      {messages.length === 0 ? (
                          <div className="h-full flex flex-col items-center justify-center text-center p-12">
                              <div className="bg-slate-50 p-12 rounded-full mb-8 text-slate-200 border-2 border-dashed border-slate-100">
                                  <svg className="w-24 h-24" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                              </div>
                              <h3 className="text-3xl font-black text-slate-800 mb-3">Welcome to VoiceBuddy</h3>
                              <p className="text-slate-500 max-w-md text-lg font-medium">Click "Start Practice" to begin your personalized AI English session.</p>
                          </div>
                      ) : (
                          messages.map((m, idx) => (
                              <div key={idx} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                  <div className={`max-w-[75%] p-5 rounded-2xl shadow-sm border ${
                                      m.role === 'user' 
                                      ? 'bg-blue-600 text-white border-blue-500 rounded-tr-none' 
                                      : 'bg-white text-slate-800 border-slate-100 rounded-tl-none'
                                  }`}>
                                      <p className="text-lg leading-relaxed font-medium">{m.text}</p>
                                      <div className={`flex items-center gap-2 mt-3 opacity-60 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                          <span className="text-[10px] font-bold uppercase tracking-tighter">
                                            {m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                          </span>
                                      </div>
                                  </div>
                              </div>
                          ))
                      )}
                  </div>

                  {/* Pied de page dynamique */}
                  {isActive && (
                      <div className="p-5 border-t border-slate-50 bg-blue-50/20 flex items-center justify-center gap-4">
                          <div className="flex items-center gap-3">
                            <span className="relative flex h-3 w-3">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-600"></span>
                            </span>
                            <p className="text-sm font-black text-blue-700 uppercase tracking-widest">VoiceBuddy is Listening...</p>
                          </div>
                      </div>
                  )}
              </div>
          </main>
        </div>

        <footer className="py-6 flex flex-col md:flex-row items-center justify-between text-slate-400 text-xs border-t border-slate-200 mt-2">
          <div className="flex items-center gap-3">
            <span className="bg-slate-200 text-slate-600 px-2 py-0.5 rounded font-black tracking-widest uppercase">v1.2 Full-Width</span>
            <span>Gemini 2.5 Live Experience</span>
          </div>
          <p>© 2025 VoiceBuddy AI — Fluent English Practice Redefined</p>
        </footer>
      </div>
    </div>
  );
};

export default App;
