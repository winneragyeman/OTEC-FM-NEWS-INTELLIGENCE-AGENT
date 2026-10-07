// Ensure window.fetch is writable and configurable across prototype chain
try {
  if (typeof window !== 'undefined') {
    let proto: any = window;
    while (proto) {
      try {
        const desc = Object.getOwnPropertyDescriptor(proto, 'fetch');
        if (desc && desc.get && !desc.set) {
          Object.defineProperty(proto, 'fetch', {
            get: desc.get,
            set: function (this: any, val: any) {
              try {
                Object.defineProperty(this, 'fetch', {
                  value: val,
                  writable: true,
                  configurable: true,
                  enumerable: true,
                });
              } catch {
                this._fetch = val;
              }
            },
            configurable: true,
            enumerable: desc.enumerable !== false,
          });
        }
      } catch {}
      proto = Object.getPrototypeOf(proto);
    }

    if (window.fetch) {
      const orig = window.fetch.bind(window);
      try {
        Object.defineProperty(window, 'fetch', {
          value: orig,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch {}
    }
  }
} catch {}

import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
