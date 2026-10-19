import { Factory } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Button, ErrorBox, Field, Input } from "../components/ui";
import { login } from "../lib/api";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  if (ready && user) return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-line bg-surface p-7">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Factory className="size-6 text-accent" aria-hidden />
          V-MES
        </div>
        <p className="text-ink-2">Üretim izleme ve OEE sistemine giriş yapın.</p>
        {error !== null && <ErrorBox error={error} />}
        <Field label="Kullanıcı adı">{(id) => <Input id={id} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />}</Field>
        <Field label="Şifre">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Giriş yap
        </Button>
      </form>
    </div>
  );
}
