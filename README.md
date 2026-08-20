# EcoTrack - Monitor de Lixeiras

Projeto IoT com Arduino Uno + HC-SR04 + Bluetooth + aplicativo MIT App Inventor + Supabase + GitHub Pages.

## Fluxo

1. O Arduino mede a distância com o HC-SR04.
2. O Arduino converte a distância para percentual de ocupação e envia apenas o número, seguido de `\n`, via Bluetooth.
3. O aplicativo recebe o percentual e envia um `POST` para `public.leituras` no Supabase.
4. O site lê `public.lixeiras` e `public.leituras`.
5. O painel usa Supabase Realtime e, como contingência, polling a cada 5 s.

## Correções aplicadas

- `script.js` agora usa o projeto Supabase correto e a chave publishable usada pelo aplicativo.
- A leitura das tabelas foi separada para não depender de relacionamento embutido do PostgREST.
- `altura_cm` agora é preservada no estado do frontend.
- Realtime possui fallback por polling.
- O aplicativo não envia mais `85` fixo: envia o percentual recebido do Arduino.
- O aplicativo só lê Bluetooth quando há bytes disponíveis.
- O intervalo do aplicativo foi alterado de 500 ms para 2 s para evitar excesso de inserts.
- O evento `Web.GotText` não apaga mais o percentual exibido.

## Arquivos

- `index.html`: dashboard responsivo.
- `style.css`: estilos adicionais.
- `script.js`: integração Supabase + Realtime/polling.
- `supabase_setup.sql`: estrutura/policies/publication necessárias.
- `arduino/monitor_lixeira.ino`: firmware do Arduino Uno.
- `app-inventor/lixeiras_corrigido.aia`: projeto corrigido do MIT App Inventor.

## Configuração do App Inventor

O projeto está configurado com `lixeira_id = 1`. Essa lixeira precisa existir em `public.lixeiras`.

Endpoint utilizado:

`https://xllbpyihfjfmtbzcrihs.supabase.co/rest/v1/leituras`

## GitHub Pages

Após habilitar GitHub Pages para a branch `main` e diretório `/ (root)`, `index.html` é publicado diretamente.
