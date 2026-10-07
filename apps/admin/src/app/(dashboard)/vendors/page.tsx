'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Vendor, Zone } from '@/lib/types';
import { Card, Table, Badge, Button, ErrorBanner } from '@/components/ui';

const EMPTY = { name: '', ownerName: '', phone: '', email: '', password: '', addressLine: '', zoneId: '' };

export default function VendorsPage() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED'>('ALL');

  const load = () => api<{ vendors: Vendor[] }>('/admin/vendors').then((r) => setVendors(r.vendors)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api<{ zones: Zone[] }>('/admin/zones').then((r) => setZones(r.zones)).catch(() => {});
  }, []);

  async function createVendor() {
    setSaving(true); setFormError(null); setCreated(null);
    try {
      await api('/admin/vendors', { method: 'POST', body: { ...form, zoneId: form.zoneId || undefined } });
      setCreated(`${form.name} created. Share the email and password with the owner so they can log in to the Doraha Eats app.`);
      setForm(EMPTY); setShowForm(false); load();
    } catch (e) { setFormError((e as Error).message); }
    finally { setSaving(false); }
  }
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function approve(id: string) { await api(`/admin/vendors/${id}/approve`, { method: 'POST' }); load(); }
  async function reject(id: string) { await api(`/admin/vendors/${id}/reject`, { method: 'POST' }); load(); }
  async function suspend(id: string) { await api(`/admin/vendors/${id}`, { method: 'PATCH', body: { status: 'SUSPENDED' } }); load(); }
  async function reactivate(id: string) { await api(`/admin/vendors/${id}`, { method: 'PATCH', body: { status: 'ACTIVE' } }); load(); }

  const shown = filter === 'ALL' ? vendors : vendors.filter((v) => v.status === filter);
  const toneFor = (s: string) => ({ PENDING: 'yellow', ACTIVE: 'green', SUSPENDED: 'red', REJECTED: 'red' } as const)[s] ?? 'neutral';

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold">Vendors</h1>
          <p className="text-sm text-neutral-500">Approve, reject or manage local stalls.</p>
        </div>
        <div className="flex gap-3 items-center">
        <Button onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : 'Add vendor'}</Button>
        <select value={filter} onChange={(e) => setFilter(e.target.value as never)} className="in w-40">
          {['ALL', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {created && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-800 text-sm p-3">{created}</div>}

      {showForm && (
        <Card className="mb-6">
          <h2 className="font-semibold mb-3">New vendor</h2>
          {formError && <ErrorBanner message={formError} />}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="in" placeholder="Stall name" value={form.name} onChange={set('name')} />
            <input className="in" placeholder="Owner name" value={form.ownerName} onChange={set('ownerName')} />
            <input className="in" placeholder="Owner mobile (10 digits)" value={form.phone} onChange={set('phone')} />
            <input className="in" type="email" placeholder="Owner email (used to log in)" value={form.email} onChange={set('email')} />
            <input className="in" type="text" placeholder="Temporary password (min 10 characters)" value={form.password} onChange={set('password')} />
            <select className="in" value={form.zoneId} onChange={set('zoneId')}>
              <option value="">Default zone</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
            <input className="in md:col-span-2" placeholder="Shop address" value={form.addressLine} onChange={set('addressLine')} />
          </div>
          <div className="mt-4"><Button onClick={createVendor} disabled={saving}>{saving ? 'Saving...' : 'Create vendor'}</Button></div>
        </Card>
      )}

      <Card>
        <Table headers={['Stall', 'Owner', 'Zone', 'Rating', 'Status', '']}>
          {shown.map((v) => (
            <tr key={v.id}>
              <td className="py-2 pr-4 font-medium">{v.name}{v.isDemo && <span className="ml-2 text-xs text-neutral-400">(demo)</span>}</td>
              <td className="py-2 pr-4 text-neutral-500">{v.ownerName}<div className="text-xs text-neutral-400">{v.owner.phone ?? v.owner.email}</div></td>
              <td className="py-2 pr-4 text-neutral-500">{v.zone?.name ?? '—'}</td>
              <td className="py-2 pr-4">{v.ratingAvg.toFixed(1)} ({v.ratingCount})</td>
              <td className="py-2 pr-4"><Badge tone={toneFor(v.status)}>{v.status}</Badge></td>
              <td className="py-2 pr-4 space-x-2">
                {v.status === 'PENDING' && <>
                  <Button onClick={() => approve(v.id)}>Approve</Button>
                  <Button variant="danger" onClick={() => reject(v.id)}>Reject</Button>
                </>}
                {v.status === 'ACTIVE' && <Button variant="secondary" onClick={() => suspend(v.id)}>Suspend</Button>}
                {(v.status === 'SUSPENDED' || v.status === 'REJECTED') && <Button variant="secondary" onClick={() => reactivate(v.id)}>Reactivate</Button>}
              </td>
            </tr>
          ))}
        </Table>
        {!shown.length && <div className="text-center py-8 text-sm text-neutral-400">No vendors in this filter.</div>}
      </Card>
    </div>
  );
}
