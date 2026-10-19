import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Checkbox, Dialog, ErrorBox, Field, Input, PageHeader, Select, Spinner, Table } from "../components/ui";
import { api } from "../lib/api";
import { ROLE_LABEL, type Role } from "../lib/auth";
import { dateTime } from "../lib/format";
import type { UserRow } from "../lib/types";

export function UsersPage() {
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<UserRow[]>("/api/users") });
  const [edit, setEdit] = useState<UserRow | "new" | null>(null);
  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Kullanıcılar" actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit("new")}>Kullanıcı ekle</Button>} />
      <Card>
        {users.isLoading ? <Spinner /> : users.error ? <div className="p-4"><ErrorBox error={users.error} /></div> : (
          <Table>
            <thead><tr><th>Kullanıcı</th><th>Ad</th><th>Rol</th><th>Durum</th><th>Son giriş</th><th /></tr></thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id}>
                  <td className="font-medium">{u.username}</td>
                  <td className="text-ink-2">{u.display_name ?? "—"}</td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td>{u.is_active ? <Badge tone="good">Aktif</Badge> : <Badge>Pasif</Badge>}</td>
                  <td className="tabular text-ink-2">{u.last_login_at ? dateTime(u.last_login_at) : "—"}</td>
                  <td className="text-right"><Button size="sm" onClick={() => setEdit(u)}>Düzenle</Button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <UserDialog user={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function UserDialog({ user, onClose }: { user: UserRow | "new" | null; onClose: () => void }) {
  const qc = useQueryClient();
  const u = user && user !== "new" ? user : null;
  const [form, setForm] = useState({ username: "", display_name: "", role: "operator" as Role, password: "", is_active: true });
  useEffect(() => {
    setForm({ username: u?.username ?? "", display_name: u?.display_name ?? "", role: u?.role ?? "operator", password: "", is_active: u?.is_active ?? true });
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () =>
      u
        ? api(`/api/users/${u.id}`, { method: "PATCH", json: { display_name: form.display_name || null, role: form.role, is_active: form.is_active, ...(form.password ? { password: form.password } : {}) } })
        : api("/api/users", { method: "POST", json: { username: form.username, display_name: form.display_name || null, role: form.role, password: form.password } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["users"] }); onClose(); },
  });
  return (
    <Dialog open={!!user} onClose={onClose} title={u ? `Kullanıcı: ${u.username}` : "Yeni kullanıcı"}
      footer={<><Button variant="ghost" onClick={onClose}>Vazgeç</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Kaydet</Button></>}>
      <div className="space-y-4">
        {save.error && <ErrorBox error={save.error} />}
        {!u && <Field label="Kullanıcı adı">{(id) => <Input id={id} autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />}</Field>}
        <Field label="Görünen ad">{(id) => <Input id={id} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />}</Field>
        <Field label="Rol" hint="Mühendis: konfigürasyon ve tanımlar · Operatör: iş emri, duruş nedeni, hurda · İzleyici: yalnızca görüntüleme">
          {(id) => (
            <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </Select>
          )}
        </Field>
        <Field label={u ? "Yeni şifre (değiştirmek için)" : "Şifre"} hint="En az 10 karakter; büyük harf, küçük harf ve rakam">
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
        </Field>
        {u && <Checkbox label="Aktif (pasif kullanıcının oturumları kapatılır)" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />}
      </div>
    </Dialog>
  );
}
