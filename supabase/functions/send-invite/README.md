# send-invite — e-mail de convite para entrar em uma carteira

Quando alguém convida um e-mail que **ainda não tem conta**, o app registra o convite e chama esta função,
que envia (via Resend) um e-mail com o passo a passo para criar a conta. Ao criar a conta com o mesmo e-mail,
a carteira aparece sozinha (função `auto_accept_my_invites`).

## Configurar (uma vez)
1. **SQL Editor:** rode `supabase/migrations/20261009000003_invite_email.sql`.
2. **Resend → API Keys → Create API Key** (nome `convites`, permissão *Sending access*, domínio `minhascarteiras.com.br`).
   Copie a chave (aparece uma única vez).
3. **Supabase → Edge Functions → Secrets:** crie `RESEND_API_KEY` com essa chave.
   (Opcionais: `FROM_EMAIL`, padrão `Minhas Carteiras <nao-responda@minhascarteiras.com.br>`; `APP_URL`, padrão `https://minhascarteiras.com.br`.)
4. **Publicar a função** `send-invite` (Edge Functions → Deploy a new function → Via Editor) com os arquivos
   `index.ts` e `handler.ts` desta pasta, e deixe **"Verify JWT" desligado** (a função valida o login sozinha).

## Regras de segurança (no `handler.ts`)
- Exige login e que a pessoa seja **dona ou admin** da carteira.
- Só envia para e-mails com **convite pendente** daquela carteira (não serve para disparar e-mail a qualquer endereço).
- Reenvio do mesmo convite: mínimo de 5 minutos; no máximo 5 e-mails por convite; no máximo 20 por hora por pessoa.
- Se o envio falhar, o convite continua registrado e o app oferece compartilhar por WhatsApp/e-mail/copiar.

## Diagnóstico
- Resposta `not_configured` (503): falta o segredo `RESEND_API_KEY`.
- `send_failed` (502): o Resend recusou — confira domínio verificado e a chave. Veja *Logs* no painel do Resend.
- `forbidden` (403): quem convidou não é dono/admin da carteira.
