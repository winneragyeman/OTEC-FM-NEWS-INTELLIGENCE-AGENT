import { useEffect, useState } from 'react';
import { Radio, Server, CheckCircle2, ShieldCheck, MapPin } from 'lucide-react';

export default function App() {
  const [serverStatus, setServerStatus] = useState<{
    status: string;
    brand: string;
    frequency: string;
    city: string;
    region: string;
    country: string;
    timestamp: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error('API server unreachable');
        return res.json();
      })
      .then((data) => {
        setServerStatus(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col justify-between font-sans selection:bg-amber-500 selection:text-black">
      {/* Top Header */}
      <header className="border-b border-neutral-800 bg-neutral-900/60 backdrop-blur px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
                OTEC FM
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-medium border border-amber-500/30">
                  102.9 MHz
                </span>
              </h1>
              <p className="text-xs text-neutral-400 flex items-center gap-1">
                <MapPin className="w-3 h-3 text-neutral-500" /> Kumasi, Ashanti, Ghana
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              Workspace Ready
            </span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-4xl mx-auto px-6 py-16 flex-1 flex flex-col items-center justify-center text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-neutral-900 border border-neutral-800 text-xs text-neutral-400 mb-6">
          <ShieldCheck className="w-4 h-4 text-amber-400" />
          News Intelligence & Editorial Platform
        </div>

        <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4">
          OTEC FM News Intelligence Platform
        </h2>

        <p className="text-neutral-400 max-w-xl text-sm sm:text-base leading-relaxed mb-8">
          The full-stack Express + React + TypeScript workspace is successfully initialized. 
          Ready for phase-by-phase implementation instructions.
        </p>

        {/* Server & Workspace Diagnostics */}
        <div className="w-full max-w-lg bg-neutral-900/80 border border-neutral-800 rounded-xl p-5 text-left text-xs shadow-xl">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-neutral-800">
            <span className="font-semibold text-neutral-300 flex items-center gap-2">
              <Server className="w-4 h-4 text-neutral-400" /> Environment Diagnostics
            </span>
            <span className="text-neutral-500 font-mono">Port 3000</span>
          </div>

          <div className="space-y-2 font-mono text-neutral-300">
            <div className="flex justify-between py-1 border-b border-neutral-800/60">
              <span className="text-neutral-500">Station Identity:</span>
              <span className="text-neutral-200 font-semibold">OTEC FM (102.9 MHz)</span>
            </div>
            <div className="flex justify-between py-1 border-b border-neutral-800/60">
              <span className="text-neutral-500">Region & City:</span>
              <span className="text-neutral-200">Kumasi, Ashanti Region, Ghana</span>
            </div>
            <div className="flex justify-between py-1 border-b border-neutral-800/60">
              <span className="text-neutral-500">Backend API:</span>
              <span className={loading ? 'text-amber-400' : error ? 'text-red-400' : 'text-emerald-400 font-semibold flex items-center gap-1'}>
                {loading ? 'Connecting...' : error ? error : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" /> /api/health responding
                  </>
                )}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-neutral-500">Stack Architecture:</span>
              <span className="text-neutral-200">Express + Vite + React 19 + TypeScript</span>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-neutral-800/80 px-6 py-4 text-center text-xs text-neutral-500">
        OTEC FM 102.9 MHz • Kumasi, Ghana • Intelligence Platform
      </footer>
    </div>
  );
}
