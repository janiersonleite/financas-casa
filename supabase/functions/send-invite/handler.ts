// Lógica pura do envio de e-mail de convite (sem dependências externas → testável em Node/Deno).

export interface Deps {
    getUser(token: string): Promise<{ id: string; email: string } | null>;
    isAdmin(financaId: string, userId: string): Promise<boolean>;
    getFinanca(financaId: string): Promise<{ name: string; emoji: string } | null>;
    getInvite(financaId: string, email: string): Promise<{
        id: string; accepted_at: string | null; expires_at: string | null; emailed_at: string | null; email_count: number;
    } | null>;
    countRecentEmailsBy(userId: string, sinceIso: string): Promise<number>;
    sendEmail(m: { to: string; subject: string; html: string; text: string; replyTo?: string }): Promise<{ ok: boolean; status: number }>;
    markEmailed(inviteId: string): Promise<void>;
    now(): number;
    appUrl: string;
}
export interface Result { status: number; body: Record<string, unknown> }

export const MIN_GAP_MS = 5 * 60 * 1000;     // reenvio do mesmo convite: no mínimo 5 min
export const MAX_PER_INVITE = 5;             // no máximo 5 e-mails por convite
export const MAX_PER_HOUR_BY_USER = 20;      // no máximo 20 e-mails de convite por hora por pessoa

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function buildEmail(p: { inviterEmail: string; financaName: string; emoji: string; to: string; appUrl: string }) {
    const subject = `Convite: carteira "${p.financaName}" no Minhas Carteiras`;
    const text =
`Olá!

${p.inviterEmail} convidou você para a carteira "${p.financaName}" no Minhas Carteiras.

Para entrar:
1) Acesse ${p.appUrl}
2) Toque em "Criar conta" usando exatamente este e-mail: ${p.to}
3) Confirme o e-mail que você vai receber e entre.

A carteira aparece automaticamente para você. O convite vale por 30 dias.

Se você não conhece quem convidou, pode ignorar esta mensagem.
— Minhas Carteiras`;
    const html =
`<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;max-width:520px">
<h2 style="margin:0 0 12px">${esc(p.emoji)} Você foi convidado(a)!</h2>
<p><strong>${esc(p.inviterEmail)}</strong> convidou você para a carteira <strong>“${esc(p.financaName)}”</strong> no Minhas Carteiras.</p>
<p style="margin:16px 0 6px"><strong>Para entrar:</strong></p>
<ol style="margin:0 0 16px;padding-left:20px;line-height:1.6">
<li>Acesse <a href="${esc(p.appUrl)}">${esc(p.appUrl)}</a></li>
<li>Toque em <strong>Criar conta</strong> usando exatamente este e-mail: <strong>${esc(p.to)}</strong></li>
<li>Confirme o e-mail que você vai receber e entre.</li>
</ol>
<p>A carteira aparece automaticamente para você. O convite vale por 30 dias.</p>
<p style="color:#6b7280;font-size:13px">Se você não conhece quem convidou, pode ignorar esta mensagem.<br>— Minhas Carteiras</p>
</div>`;
    return { subject, text, html };
}

export async function handleSendInvite(deps: Deps, token: string | null, body: unknown): Promise<Result> {
    if (!token) return { status: 401, body: { error: 'unauthorized' } };
    const user = await deps.getUser(token);
    if (!user) return { status: 401, body: { error: 'unauthorized' } };

    const b = (body ?? {}) as { financa_id?: unknown; email?: unknown };
    const financaId = typeof b.financa_id === 'string' ? b.financa_id : '';
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!/^[0-9a-f-]{36}$/i.test(financaId) || !EMAIL_RE.test(email) || email.length > 254)
        return { status: 400, body: { error: 'invalid_input' } };

    if (!(await deps.isAdmin(financaId, user.id))) return { status: 403, body: { error: 'forbidden' } };

    const invite = await deps.getInvite(financaId, email);
    const now = deps.now();
    if (!invite || invite.accepted_at || (invite.expires_at && Date.parse(invite.expires_at) < now))
        return { status: 404, body: { error: 'no_invite' } };

    if (invite.email_count >= MAX_PER_INVITE) return { status: 429, body: { error: 'limit_reached' } };
    if (invite.emailed_at && now - Date.parse(invite.emailed_at) < MIN_GAP_MS)
        return { status: 429, body: { error: 'too_soon', retry_after: Math.ceil((MIN_GAP_MS - (now - Date.parse(invite.emailed_at))) / 1000) } };
    if ((await deps.countRecentEmailsBy(user.id, new Date(now - 3600_000).toISOString())) >= MAX_PER_HOUR_BY_USER)
        return { status: 429, body: { error: 'hourly_limit' } };

    const financa = await deps.getFinanca(financaId);
    if (!financa) return { status: 404, body: { error: 'no_financa' } };

    const msg = buildEmail({ inviterEmail: user.email, financaName: financa.name, emoji: financa.emoji || '💰', to: email, appUrl: deps.appUrl });
    let sent: { ok: boolean; status: number };
    try { sent = await deps.sendEmail({ to: email, subject: msg.subject, html: msg.html, text: msg.text, replyTo: user.email }); }
    catch { return { status: 502, body: { error: 'send_failed' } }; }
    if (!sent.ok) return { status: 502, body: { error: 'send_failed' } };

    await deps.markEmailed(invite.id);
    return { status: 200, body: { sent: true } };
}
