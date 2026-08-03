/**
 * Device-flow login.
 *
 * Renders the verification URL as a QR code so a phone can scan it instead of
 * typing a 9-digit code — which matters, because this gets used at the range.
 *
 * The flow is genuinely fragile in one specific way, learned the hard way in
 * Phase 0: if the Trackman session drops between issuing the code and the user
 * approving it, the consent POST silently fails and polling hangs until the
 * code expires. So expiry is a first-class state with a one-tap retry, never a
 * dead screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  requestDeviceCode,
  pollForToken,
  DeviceCodeExpired,
} from '../api/auth';
import type { DeviceCodeResponse } from '../api/types';

type State =
  | { k: 'idle' }
  | { k: 'starting' }
  | { k: 'waiting'; dev: DeviceCodeResponse; secondsLeft: number }
  | { k: 'expired' }
  | { k: 'error'; message: string };

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [state, setState] = useState<State>({ k: 'idle' });
  const [qr, setQr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setQr(null);
    setState({ k: 'starting' });

    try {
      const dev = await requestDeviceCode();
      setState({ k: 'waiting', dev, secondsLeft: dev.expires_in });
      QRCode.toDataURL(dev.verification_uri_complete, {
        width: 260,
        margin: 1,
        color: { dark: '#e8eaed', light: '#00000000' },
      }).then(setQr, () => setQr(null));

      await pollForToken(dev, {
        signal: ac.signal,
        onTick: (secondsLeft) =>
          setState((s) => (s.k === 'waiting' ? { ...s, secondsLeft } : s)),
      });
      if (!ac.signal.aborted) onSignedIn();
    } catch (e) {
      if (ac.signal.aborted) return;
      if (e instanceof DeviceCodeExpired) setState({ k: 'expired' });
      else setState({ k: 'error', message: (e as Error).message });
    }
  }, [onSignedIn]);

  useEffect(() => () => abort.current?.abort(), []);

  return (
    <div className="login">
      <h1>untrackman</h1>
      <p className="sub">Your Trackman Range data, actually yours.</p>

      {state.k === 'idle' && (
        <button className="primary" onClick={start}>
          Sign in with Trackman
        </button>
      )}

      {state.k === 'starting' && <p className="muted">Requesting a code…</p>}

      {state.k === 'waiting' && (
        <div className="device">
          {qr && <img className="qr" src={qr} alt="Scan to approve sign-in" />}
          <ol className="steps">
            <li>
              Open{' '}
              <a href={state.dev.verification_uri_complete} target="_blank" rel="noreferrer">
                {state.dev.verification_uri.replace('https://', '')}
              </a>{' '}
              — or scan the code above
            </li>
            <li>
              Confirm it shows <code>{state.dev.user_code}</code>
            </li>
            <li>Tap <strong>Yes, allow</strong></li>
          </ol>
          <p className="muted">
            Waiting for approval… {state.secondsLeft}s
          </p>
          <p className="hint">
            Not signed in on Trackman? Use the <strong>QUICK LOGIN</strong> PIN on that
            page with the TrackMan Golf app — it skips the password and the CAPTCHA.
          </p>
          <button className="ghost" onClick={start}>Start over</button>
        </div>
      )}

      {state.k === 'expired' && (
        <div className="device">
          <p>That code expired before it was approved.</p>
          <button className="primary" onClick={start}>Get a new code</button>
        </div>
      )}

      {state.k === 'error' && (
        <div className="device">
          <p className="error">{state.message}</p>
          <button className="primary" onClick={start}>Try again</button>
        </div>
      )}
    </div>
  );
}
