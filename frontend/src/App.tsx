import { useEffect, useState } from 'react';
import './App.css';

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

type BackendStatus = 'checking' | 'connected' | 'unreachable';

function App() {
  const [backend, setBackend] = useState<BackendStatus>('checking');

  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((res) => setBackend(res.ok ? 'connected' : 'unreachable'))
      .catch(() => setBackend('unreachable'));
  }, []);

  return (
    <main className="container">
      <h1>Flash Sale</h1>
      <p>
        Backend:{' '}
        {backend === 'checking'
          ? 'Checking…'
          : backend === 'connected'
            ? 'Connected'
            : 'Unreachable'}
      </p>
    </main>
  );
}

export default App;
