# 10. Testes e validação do MVP

Este capítulo descreve como foi verificada a extensão de vídeo do PictuRAS: a estratégia e o
ambiente de teste (10.1), os testes realizados com o respetivo resultado (10.2), o resumo da
execução (10.3), os defeitos encontrados e corrigidos durante a verificação (10.4) e as
limitações conhecidas (10.5). Os testes fecham o ciclo *caso de uso → requisito → componente →
teste*: cada linha das tabelas indica o elemento do caso de uso ou o requisito que verifica. Os
componentes que realizam cada requisito constam do Cap. 7.3.

## 10.1. Estratégia e ambiente

### Estratégia

A verificação combinou quatro níveis. Os níveis mais baixos cobrem exaustivamente as regras de
negócio e os limites; os mais altos confirmam que os serviços cooperam corretamente na
instalação real.

| Nível | Objeto de teste | O que é real | O que é simulado | N.º de testes |
|-------|-----------------|--------------|------------------|---------------|
| **Componente — rotas** | API interna de vídeo do `imageStorageService` (*router* Express de produção) | Validação, regras de perfil, códigos HTTP | MongoDB, SeaweedFS (S3) e *workers*, por réplicas em memória | 33 |
| **Componente — *workers*** | *Workers* de metadados, recorte e extração de fotogramas | **ffmpeg/ffprobe** sobre vídeos gerados no momento do teste | MongoDB, S3 e os serviços `users` e `projects` | 25 |
| **Gateway** | Rotas de vídeo do `apiGateway` | Verificação de JWT, débito e reembolso de operações | Serviços `users` e `imageStorageService` | 16 |
| **Sistema (E2E)** | Aplicação completa através do ponto de entrada público (nginx) | Todos os serviços, as bases de dados e o SeaweedFS | Nada | 13 |
| **Manual (interface)** | Interface web (`https://localhost:8080`), conduzida num browser *headless* | Tudo | Nada | 10 |

Princípios seguidos:

- **Limites testados nas fronteiras.** Cada limite por perfil é testado no valor permitido e no
  valor imediatamente acima (por exemplo, 300 s e 300,5 s de recorte no perfil gratuito), para os
  dois perfis.
- **Media real.** Os testes dos *workers* não simulam o ffmpeg. Geram clips sintéticos (MP4
  H.264+AAC, MOV H.264, WebM VP9+Opus, MP4 MPEG-4 Part 2, um WebM renomeado para `.mp4`, um MP4 com
  rotação de 90° e um ficheiro corrompido) e verificam o resultado com ffprobe.
- **Tempo limite testável.** O limite de 10 minutos é configurável (`VIDEO_TASK_TIMEOUT_MS`), o que
  permite exercitá-lo nos testes com limites de milissegundos sem alterar o comportamento em
  produção.
- **Dados do cliente não são confiáveis.** Há testes específicos que enviam um perfil, uma
  extensão ou um MIME falsos e confirmam que o servidor os ignora ou recusa.
- **Estados finais e efeitos laterais.** Para cada falha ou cancelamento verifica-se o estado
  final da tarefa, o número de reembolsos da operação diária, a remoção de ficheiros temporários e
  a ausência de objetos órfãos no armazenamento.
- **Identificação.** O nome de cada teste começa pelo seu ID (`TST-{FUNC}-nn`), o que permite
  rastrear os resultados da execução diretamente para as tabelas deste capítulo.

### Ferramentas

- **Node.js `node:test` e `node:assert`**, nativos do Node, sem dependências adicionais. Os
  testes encontram-se em `imageStorageService/test/` e `apiGateway/test/`.
- **Réplicas em memória** (`imageStorageService/test/helpers/`) dos modelos Mongoose e do cliente
  S3, injetadas na *cache* de módulos CommonJS antes de carregar o código de produção. O código
  testado é exatamente o que corre em produção.
- **ffmpeg/ffprobe** instalados na imagem Docker `img_storage`.
- **Docker Compose** para os testes de sistema, executados num contentor ligado à rede interna
  da aplicação.
- **Chromium *headless*** (Playwright/patchright), conduzido por *scripts* que reproduzem os passos
  dos testes manuais: carregar ficheiros, preencher diálogos, cancelar tarefas e navegar. As
  verificações de interface usam a árvore de acessibilidade e capturas de ecrã.

### Ambiente

| Elemento | Versão |
|----------|--------|
| Sistema anfitrião | Windows 11, Docker Desktop 4.45 (Docker Engine 28.3.3, WSL 2) |
| Node.js (anfitrião) | 22.19 |
| Imagem `img_storage` | Node.js 20, ffmpeg do Debian bookworm |
| Base de dados | MongoDB 4.4 |
| Armazenamento de objetos | SeaweedFS 4.47 (API S3) |
| Browser (testes de interface) | Chromium *headless*, janela de 1366×900 |
| Código testado | Branch `feat/fase1-testes-evidencias`, *commit* `8fb6ade` |
| Datas de execução | 18 e 21 de outubro de 2026 (execução final: 21 de outubro) |

As instruções para reproduzir todas as execuções estão no Anexo (Instruções de execução dos
testes).

## 10.2. Testes realizados

Legenda — **Tipo**: C = componente, C+ff = componente com ffmpeg real, GW = gateway, E2E =
sistema, M = manual. **Resultado**: ✔ passou na execução final; «falhava antes de …» indica que
o teste detetou um defeito (ver 10.4) e passou depois da correção.

### 10.2.1. Submeter vídeo e biblioteca (UC-VID-001)

| ID | Tipo | Descrição (Dado … Quando … Então) | Requisitos | Resultado |
|----|------|-----------------------------------|------------|-----------|
| TST-UPLOAD-01 | C | **Dado** um ficheiro MP4, MOV ou WebM com o MIME correspondente, **quando** o upload é iniciado, **então** é criada uma sessão *multipart* em estado `uploading` com partes de 8 MiB. | UC-VID-001 (formatos suportados) | ✔ |
| TST-UPLOAD-02 | C | **Dado** um nome de ficheiro malicioso (`../../etc/passwd.mp4`), **quando** o upload é iniciado, **então** a chave de armazenamento é gerada pelo servidor (`videos/<uuid>.mp4`) e o nome original fica apenas como metadado. | UC-VID-001; RNF44 (ALT) | ✔ |
| TST-UPLOAD-03 | C | **Dada** uma extensão não suportada, ou um MIME que não corresponde à extensão, **quando** o upload é iniciado, **então** o pedido é recusado (400) e nada é criado. | UC-VID-001 (formatos suportados) | ✔ |
| TST-UPLOAD-04 | C | **Dado** um ficheiro de 200 MB e outro de 200 MB + 1 byte (gratuito), e de 2000 MB e 2000 MB + 1 byte (Premium), **quando** o upload é iniciado, **então** o limite é aceite e o limite + 1 é recusado. | UC-VID-001; RNG de limites por perfil | ✔ |
| TST-UPLOAD-05 | C | **Dado** um utilizador gratuito perto da quota total de 1 GiB, **quando** inicia um upload que a ultrapassa, **então** recebe 413; vídeos falhados e vídeos de outros utilizadores não contam para a quota. | UC-VID-001; RNG de quota de armazenamento | ✔ |
| TST-UPLOAD-06 | C | **Dada** uma sessão de upload ativa, **quando** chega uma parte com identificador de sessão errado ou dirigida a outro utilizador, **então** a parte é recusada (404). | UC-VID-001; RNF44 (ALT) | ✔ |
| TST-UPLOAD-07 | C | **Dado** um pedido de conclusão sem partes, **quando** é recebido, **então** é recusado (400). | UC-VID-001 | ✔ |
| TST-UPLOAD-08 | C | **Dado** um objeto final cujo tamanho difere do declarado, **quando** o upload é concluído, **então** o objeto é apagado e o vídeo fica `failed` (422). | UC-VID-001 (integridade) | ✔ |
| TST-UPLOAD-09 | C | **Dadas** partes enviadas fora de ordem, **quando** o upload é concluído, **então** as partes são ordenadas, o vídeo passa a `processing` e é agendada a inspeção de metadados. | UC-VID-001 | ✔ |
| TST-UPLOAD-10 | C | **Dada** uma sessão ativa, **quando** o utilizador cancela, **então** a sessão *multipart* é abortada no armazenamento e o registo é removido. | UC-VID-001 (cancelamento) | ✔ |
| TST-UPLOAD-11 | C | **Dado** um vídeo válido, **quando** a inspeção termina, **então** a duração, a resolução, os codecs, os FPS e a rotação ficam persistidos e o vídeo fica `ready`. | UC-VID-001 (metadados) | ✔ |
| TST-UPLOAD-12 | C | **Dado** um ficheiro inválido, **quando** a inspeção falha, **então** o objeto é apagado, o vídeo fica `failed` e não aparece na biblioteca. | UC-VID-001 (exceção: ficheiro inválido) | ✔ |
| TST-UPLOAD-13 | C | **Dados** três uploads concluídos em simultâneo, **quando** são processados, **então** a inspeção ocorre em série e pela ordem de chegada. | UC-VID-001 | ✔ |
| TST-META-01 | C+ff | **Dado** um MP4 H.264+AAC de 10 s, 320×240 e 25 fps, **quando** é inspecionado, **então** é aceite e os metadados correspondem a esses valores. | UC-VID-001 (combinações suportadas) | ✔ |
| TST-META-02 | C+ff | **Dado** um MOV H.264 sem áudio, **quando** é inspecionado, **então** é aceite com `audioCodec = none`. | UC-VID-001 | ✔ |
| TST-META-03 | C+ff | **Dado** um WebM VP9+Opus, **quando** é inspecionado, **então** é aceite. | UC-VID-001 | ✔ |
| TST-META-04 | C+ff | **Dado** um MP4 com vídeo MPEG-4 Part 2, **quando** é inspecionado, **então** é recusado por codec não suportado. | UC-VID-001 (exceção: codec não suportado) | ✔ |
| TST-META-05 | C+ff | **Dado** um WebM renomeado para `.mp4`, **quando** é inspecionado, **então** é recusado. | UC-VID-001 (exceção: ficheiro falsificado) | ✔ |
| TST-META-06 | C+ff | **Dado** um ficheiro de texto renomeado para `.mp4`, **quando** é inspecionado, **então** é recusado. | UC-VID-001 (exceção: ficheiro corrompido) | ✔ |
| TST-META-07 | C+ff | **Dado** um objeto armazenado, **quando** é inspecionado, com sucesso ou com falha, **então** o ficheiro temporário descarregado é sempre apagado. | UC-VID-001 | ✔ |
| TST-META-08 | C+ff | **Dado** um vídeo 320×240 gravado com rotação de 90° (como num telemóvel na vertical), **quando** é inspecionado, **então** a rotação de 90° fica registada nos metadados. | UC-VID-001 (metadados) | ✔ |
| TST-LIB-01 | C | **Dados** vídeos de vários utilizadores e em vários estados, **quando** um utilizador consulta a biblioteca, **então** vê apenas os seus vídeos `ready`, cada um com URL de reprodução. | UC-VID-001; RNF44 (ALT) | ✔ |
| TST-LIB-02 | C | **Dado** um vídeo de outro utilizador, **quando** se tenta apagá-lo, **então** nada acontece; apagar um vídeo próprio remove o objeto e o registo. | UC-VID-001; RNF44 (ALT) | ✔ |

### 10.2.2. Recortar vídeo (UC-VID-004)

| ID | Tipo | Descrição (Dado … Quando … Então) | Requisitos | Resultado |
|----|------|-----------------------------------|------------|-----------|
| TST-TRIM-01 | C | **Dada** uma origem WebM ou HEVC, **quando** é pedido um recorte, **então** é recusado (400); um MOV H.264 é aceite. | UC-VID-004/RN2 | ✔ |
| TST-TRIM-02 | C | **Dado** um vídeo que ainda não está `ready`, ou que pertence a outro utilizador, **quando** é pedido um recorte, **então** a resposta é 404. | UC-VID-004; RNF44 (ALT) | ✔ |
| TST-TRIM-03 | C | **Dada** uma origem com mais de 200 MB, **quando** é pedido um recorte, **então** é recusado no perfil gratuito e aceite no Premium. | REQ-VID-TRIM-NF04 | ✔ |
| TST-TRIM-04 | C | **Dados** instantes com `início < 0`, `início ≥ fim`, `fim > duração` ou valores não numéricos, **quando** é pedido um recorte, **então** é recusado (400); `fim = duração` é aceite. | REQ-VID-TRIM-NF02 | ✔ |
| TST-TRIM-05 | C | **Dado** um segmento de 300 s / 300,5 s (gratuito) e de 3600 s / 3601 s (Premium), **quando** é pedido o recorte, **então** o limite é aceite e o valor acima é recusado. | REQ-VID-TRIM-NF03 | ✔ |
| TST-TRIM-06 | C | **Dada** uma tarefa de vídeo ativa, **quando** um utilizador gratuito pede outro recorte, **então** recebe 429; um Premium pode ter até 3 tarefas ativas. | REQ-VID-TRIM-NF05 | ✔ |
| TST-TRIM-07 | C | **Dado** um pedido válido, **quando** é aceite, **então** é criada uma tarefa `queued` com o nome por omissão `<nome>-trim.<ext>`, a indicação de operação debitada e o perfil do utilizador. | UC-VID-004 (fluxo principal) | ✔ |
| TST-TRIM-08 | C+ff | **Dado** um vídeo de 10 s, **quando** é recortado o intervalo 2–5 s, **então** é criado um novo vídeo `ready`, H.264+AAC, com duração entre 2,95 e 3,5 s, e o original é mantido. | UC-VID-004/RN6 (recorte sem perdas) | ✔ (ver L-01) |
| TST-TRIM-09 | C+ff | **Dada** a opção «Substituir original», **quando** o recorte termina, **então** o registo existente é atualizado (nome, tamanho, metadados) e o objeto antigo é apagado. | UC-VID-004/FA2 | ✔ |
| TST-TRIM-10 | C+ff | **Dado** um recorte em processamento, **quando** o utilizador cancela, **então** a tarefa fica `cancelled`, não é criado vídeo e a operação é reembolsada **exatamente uma vez**. | UC-VID-004 (cancelamento) | ✔ (falhava antes de `f192dac`, D-01) |
| TST-TRIM-11 | C | **Dado** um recorte em fila, **quando** é cancelado, **então** o ffmpeg não chega a ser executado e há um único reembolso. | UC-VID-004 (cancelamento) | ✔ |
| TST-TRIM-12 | C | **Dada** uma falha do *worker* (origem indisponível), **quando** o recorte é executado, **então** há uma repetição automática, depois a tarefa fica `failed`, a operação é reembolsada e os temporários são removidos. | REQ-VID-TRIM-NF12 | ✔ |
| TST-TRIM-13 | C+ff | **Dada** uma quota de armazenamento cheia, **quando** o recorte termina, **então** um utilizador gratuito recebe «Armazenamento insuficiente» com reembolso, e um Premium com a mesma utilização conclui. | UC-VID-004 (exceção: armazenamento cheio) | ✔ (falhava antes de `f192dac`, D-02) |
| TST-TRIM-14 | C+ff | **Dado** um tempo limite que expira durante o ffmpeg, **quando** o recorte é executado, **então** o processo é terminado, a tarefa fica `failed`, não é criado vídeo, os temporários são removidos e há um reembolso. | REQ-VID-TRIM-NF10 | ✔ (ver Q-01) |

### 10.2.3. Extrair fotogramas (UC-VID-003)

| ID | Tipo | Descrição (Dado … Quando … Então) | Requisitos | Resultado |
|----|------|-----------------------------------|------------|-----------|
| TST-FRAME-01 | C | **Dada** uma origem WebM, **quando** é pedida a extração, **então** é recusada; um MP4 H.264 é aceite. | REQ-VID-FRAME-015 | ✔ |
| TST-FRAME-02 | C | **Dadas** origens acima de 200 MB, em 4K e em 8K, **quando** é pedida a extração, **então** aplicam-se os limites do perfil: gratuito até 1080p e 200 MB; Premium até 4K e 2 GB; 8K é sempre recusado. | REQ-VID-FRAME-016 | ✔ |
| TST-FRAME-03 | C | **Dados** um intervalo vazio, um intervalo além da duração e intervalos de 120/121 s (gratuito) e 1800/1801 s (Premium), **quando** é pedida a extração, **então** são aceites apenas os intervalos válidos dentro do limite. | REQ-VID-FRAME-005, REQ-VID-FRAME-016 | ✔ |
| TST-FRAME-04 | C | **Dado** um passo de amostragem de 0, 61, 1,5 ou não numérico, **quando** é pedida a extração, **então** é recusada; 60 s é aceite. | REQ-VID-FRAME-005 | ✔ |
| TST-FRAME-05 | C | **Dado** um pedido que gera 31 fotogramas num perfil gratuito, **quando** é submetido, **então** é recusado com a sugestão «passo de pelo menos 3 s»; no Premium, 200 são aceites e 201 recusados. | REQ-VID-FRAME-016; UC-VID-003/RN5 | ✔ |
| TST-FRAME-06 | C | **Dado** o formato de saída GIF, **quando** é pedida a extração, **então** é recusada; `JPEG` é aceite e normalizado. | REQ-VID-FRAME-035 | ✔ |
| TST-FRAME-07 | C | **Dada** uma extração ativa, **quando** um gratuito pede outra, **então** recebe 429; um Premium pode ter até 3; um recorte ativo não conta para este limite. | REQ-VID-FRAME-021 | ✔ |
| TST-FRAME-08 | C | **Dado** o destino «projeto existente» sem identificador de projeto, **quando** é pedida a extração, **então** é recusada (400). | UC-VID-003/FA2 | ✔ |
| TST-FRAME-09 | C | **Dado** o intervalo 2–22 s com passo 5 s, **quando** a tarefa é criada, **então** regista 5 fotogramas e o nome de projeto por omissão «<vídeo> - Fotogramas». | REQ-VID-FRAME-005 | ✔ |
| TST-FRAME-10 | C+ff | **Dado** o intervalo 0–4 s com passo 2 s em PNG para um projeto novo, **quando** a extração termina, **então** existem 3 imagens `clip_00-00-0X-000.png` no armazenamento do utilizador, cada uma com SHA-256, e o projeto é criado através do endpoint interno autenticado. | REQ-VID-FRAME-032, REQ-VID-FRAME-040 | ✔ |
| TST-FRAME-11 | C+ff | **Dado** o intervalo 1,5–3,5 s com passo 1 s em JPEG para um projeto existente, **quando** a extração termina, **então** as imagens são acrescentadas ao projeto com nomes ao milissegundo (`…_00-00-01-500.jpg`). | UC-VID-003/FA2; REQ-VID-FRAME-035 | ✔ |
| TST-FRAME-12 | C+ff | **Dado** o serviço de projetos indisponível, **quando** a extração termina, **então** há uma repetição automática, a tarefa fica `failed`, todas as imagens carregadas são apagadas e há um reembolso. | REQ-VID-FRAME-046, REQ-VID-FRAME-050 | ✔ |
| TST-FRAME-13 | C | **Dada** uma extração em processamento, **quando** o utilizador cancela, **então** a tarefa fica `cancelled`, não é criado projeto e há **exatamente um** reembolso. | UC-VID-003 (cancelamento) | ✔ (falhava antes de `f192dac`, D-01) |
| TST-FRAME-14 | C+ff | **Dada** uma quota de armazenamento cheia, **quando** a extração termina, **então** um gratuito falha e um Premium com a mesma utilização conclui. | REQ-VID-FRAME-051 | ✔ (falhava antes de `f192dac`, D-02) |
| TST-FRAME-15 | C+ff | **Dado** um tempo limite que expira durante o envio de um fotograma para o armazenamento, **quando** a extração é executada, **então** a tarefa fica `failed` com a mensagem de tempo excedido, não é repetida, não é criado projeto, não fica nenhum fotograma no armazenamento e há um reembolso. | REQ-VID-FRAME-052 | ✔ (falhava antes de `263904b`, D-04) |
| TST-FRAME-16 | C+ff | **Dado** um vídeo gravado com rotação de 90°, **quando** é extraído um fotograma, **então** a imagem sai direita (240×320). | UC-VID-003 (orientação) | ✔ |

### 10.2.4. Acompanhar tarefas, autenticação e quota diária (transversal)

Estes requisitos são comuns aos três casos de uso. Por isso são verificados uma só vez.

| ID | Tipo | Descrição (Dado … Quando … Então) | Requisitos | Resultado |
|----|------|-----------------------------------|------------|-----------|
| TST-STATUS-01 | C | **Dadas** tarefas em vários estados e de vários utilizadores, **quando** um utilizador lista as suas tarefas, **então** obtém apenas as próprias em `queued` ou `processing`. | UC-VID-003, UC-VID-004 (acompanhar tarefa) | ✔ |
| TST-STATUS-02 | C | **Dada** uma tarefa de outro utilizador, **quando** é consultada, **então** a resposta é 404. | RNF44 (ALT) | ✔ |
| TST-STATUS-03 | C | **Dadas** uma tarefa de recorte e uma de extração, **quando** são canceladas, **então** cada cancelamento é tratado pelo *worker* do tipo correspondente. | UC-VID-003, UC-VID-004 | ✔ |
| TST-SEC-01 | C | **Dado** um pedido aos serviços internos sem *token* de serviço, ou com um *token* errado, **quando** chega, **então** é recusado (403). | RNF44 (ALT) | ✔ |
| TST-SEC-02 | C | **Dado** um identificador de vídeo ou de tarefa malformado, **quando** é usado em qualquer rota, **então** a resposta é 404. | Robustez | ✔ (corrigido em `85c1077`, D-03) |
| TST-GW-01 | GW | **Dado** um pedido sem JWT, com JWT inválido ou com JWT de outro utilizador, **quando** chega ao gateway, **então** é recusado (401) sem chamar nenhum serviço interno. | RNF44 (ALT) | ✔ |
| TST-GW-02 | GW | **Dado** um pedido autenticado, **quando** é reencaminhado, **então** leva o *token* de serviço interno. | RNF44 (ALT) | ✔ |
| TST-GW-03 | GW | **Dado** um utilizador anónimo, **quando** tenta iniciar um upload, **então** é recusado (403) antes de chegar ao armazenamento. | UC-VID-001 (perfis) | ✔ |
| TST-GW-04 | GW | **Dado** um pedido em que o cliente declara ser Premium, **quando** é reencaminhado, **então** o perfil usado é o devolvido pelo serviço `users`. | Dados do cliente não são confiáveis | ✔ |
| TST-GW-05 | GW | **Dados** um upload, a sua conclusão e o seu cancelamento, **quando** são processados, **então** nenhum consome operações diárias. | RNG da quota diária; RNF48 (ALT) | ✔ |
| TST-GW-06 | GW | **Dado** um erro do armazenamento (413), **quando** ocorre, **então** é devolvido ao cliente com o mesmo código e mensagem. | UC-VID-001 | ✔ |
| TST-GW-TRIM-01 / TST-GW-FRAME-01 | GW | **Dado** um utilizador anónimo, **quando** pede um recorte ou uma extração, **então** é recusado sem débito. | UC-VID-004, UC-VID-003 (perfis) | ✔ |
| TST-GW-TRIM-02 / TST-GW-FRAME-02 | GW | **Dado** um utilizador gratuito, **quando** pede a operação, **então** é debitada 1 operação diária **antes** de criar a tarefa, e o perfil enviado é o do serviço `users`. | RNG da quota diária; REQ-VID-FRAME-024 | ✔ |
| TST-GW-TRIM-03 / TST-GW-FRAME-03 | GW | **Dada** a quota diária esgotada, **quando** o utilizador pede a operação, **então** é recusado (403) e a tarefa não é criada. | RNG da quota diária; T-07 | ✔ |
| TST-GW-TRIM-04 / TST-GW-FRAME-04 | GW | **Dada** uma falha na criação da tarefa, **quando** o gateway recebe o erro, **então** reembolsa a operação e devolve o erro original. | RNG da quota diária | ✔ |
| TST-GW-TRIM-05 / TST-GW-FRAME-05 | GW | **Dado** um utilizador Premium, **quando** pede a operação, **então** nunca é debitado. | RNG da quota diária | ✔ |

### 10.2.5. Testes de sistema (E2E)

Executados contra a aplicação completa, através do nginx, com contas criadas para cada execução.
O estado final é verificado diretamente no SeaweedFS (objetos e sessões *multipart*) e no
contador de operações do serviço `users`.

| ID | Tipo | Descrição (Dado … Quando … Então) | Requisitos | Resultado |
|----|------|-----------------------------------|------------|-----------|
| TST-E2E-01 | E2E | **Dado** um utilizador anónimo, **quando** tenta fazer upload, recorte ou extração, **então** os três pedidos são recusados (403). | UC-VID-001/003/004 (perfis) | ✔ |
| TST-E2E-02 | E2E | **Dados** MP4, MOV e WebM válidos, **quando** são enviados em partes de 8 MiB, **então** ficam `ready` com metadados, aparecem na biblioteca e o contador de operações não muda. | UC-VID-001 | ✔ |
| TST-E2E-03 | E2E | **Dado** um ficheiro de texto renomeado para `.mp4`, **quando** é enviado, **então** fica `failed`, o objeto deixa de existir no SeaweedFS e o ficheiro não aparece na biblioteca. | UC-VID-001 (exceção) | ✔ |
| TST-E2E-04 | E2E | **Dados** um MP4 com codec não suportado e um WebM renomeado para `.mp4`, **quando** são enviados, **então** ambos ficam `failed` e os objetos são apagados. | UC-VID-001 (exceção) | ✔ |
| TST-E2E-05 | E2E | **Dado** um ficheiro com 200 MB + 1 byte, **quando** um gratuito inicia o upload, **então** é recusado antes de enviar qualquer byte; um Premium pode iniciá-lo. | UC-VID-001 (limites) | ✔ |
| TST-E2E-06 | E2E | **Dado** um upload com uma parte já enviada, **quando** é cancelado, **então** o registo desaparece e a sessão *multipart* deixa de existir no SeaweedFS. | UC-VID-001 (cancelamento) | ✔ |
| TST-E2E-07 | E2E | **Dado** um lote de 6 ficheiros, **quando** são enviados em paralelo, **então** os seis ficam `ready`. | UC-VID-001 (lote) | ✔ |
| TST-E2E-08 | E2E | **Dadas** sessões que reservam 1000 MB, **quando** um gratuito inicia mais um upload de 200 MB, **então** recebe 413; depois de cancelar as reservas, pode voltar a enviar. | UC-VID-001 (quota total) | ✔ |
| TST-E2E-09 | E2E | **Dado** um vídeo pronto, **quando** é recortado o intervalo 2–5 s, **então** surge um novo vídeo com o nome pedido e o contador desce 1. | UC-VID-004; RNF48 (ALT) | ✔ |
| TST-E2E-10 | E2E | **Dado** um vídeo pronto, **quando** são extraídos fotogramas de 0–4 s com passo 2 s para um projeto novo, **então** o projeto existe com o nome pedido e 3 imagens, e o contador desce 1. | UC-VID-003; RNF48 (ALT) | ✔ |
| TST-E2E-11 | E2E | **Dado** um recorte de um gratuito em fila atrás de três recortes Premium, **quando** é cancelado, **então** fica `cancelled`, sem vídeo resultante, e o contador volta exatamente ao valor anterior. | UC-VID-004 (cancelamento) | ✔ |
| TST-E2E-12 | E2E | **Dado** um gratuito que consumiu as 5 operações do dia, **quando** pede um sexto recorte ou uma extração, **então** é recusado (403); um Premium não é limitado. | RNG da quota diária | ✔ (1.ª execução revelou D-03) |
| TST-E2E-13 | E2E | **Dado** um vídeo de outro utilizador, **quando** um utilizador o tenta ler (no caminho do dono ou no seu) ou apagar, **então** a leitura é recusada (401/404), a tentativa de apagar não tem efeito e o vídeo mantém-se intacto. | RNF44 (ALT) | ✔ |

### 10.2.6. Testes manuais da interface

Verificam o que os testes automáticos não cobrem: o comportamento da interface web (progresso,
navegação durante uploads, mensagens ao utilizador e contadores). Foram executados com uma conta
gratuita nova em cada cenário, num browser *headless* conduzido por *scripts* que repetem os
passos de um utilizador. O estado foi lido na árvore de acessibilidade e confirmado com capturas
de ecrã. Três testes falharam na primeira execução e revelaram os defeitos D-05 e D-06 (ver 10.4);
o resultado indicado é o da execução final, já com as correções.

| ID | Tipo | Descrição (Dado … Quando … Então) | Requisitos | Resultado |
|----|------|-----------------------------------|------------|-----------|
| TST-MAN-01 | M | **Dados** um MP4, um MOV e um WebM, **quando** são selecionados para upload, **então** o painel mostra o progresso e a inspeção de cada ficheiro, e cada vídeo aparece na biblioteca com resolução, duração e FPS (por exemplo, «640×360 · 0:10 · 25.00 fps»). | UC-VID-001 | ✔ (taxa e ETA não observáveis com ficheiros pequenos) |
| TST-MAN-02 | M | **Dado** um lote de 6 ficheiros, **quando** é selecionado, **então** é recusado com «Select at most 5 videos per batch.»; **dado** um lote de 5, **quando** o utilizador navega para outra página do dashboard e volta, **então** os 5 vídeos ficam prontos na biblioteca. | UC-VID-001 (lote) | ✔ |
| TST-MAN-03 | M | **Dado** um upload de 30 MB em curso, **quando** é cancelado (a 28%), **então** o envio para e o ficheiro não aparece na biblioteca. | UC-VID-001 (cancelamento) | ✔ |
| TST-MAN-04 | M | **Dado** um ficheiro de texto renomeado para `.mp4`, **quando** é enviado, **então** é mostrada a mensagem «The uploaded file is corrupt or has an invalid video format.» e o ficheiro não aparece na biblioteca. | UC-VID-001 (exceção) | ✔ |
| TST-MAN-05 | M | **Dado** um vídeo pronto, **quando** o fim do recorte é alterado para 10 s e o recorte é submetido, **então** a duração do segmento atualiza-se de imediato (00:10.0), a tarefa aparece no monitor «Tarefas de vídeo», o vídeo resultante aparece na biblioteca e o contador de operações passa de 5 para 4 **sem recarregar a página**. | UC-VID-004; RNF48 (ALT) | ✔ (falhava antes de `8fb6ade`, D-05) |
| TST-MAN-06 | M | **Dada** uma conta gratuita e um vídeo de 6:40, **quando** é selecionado o vídeo inteiro (400 s), **então** o diálogo mostra «Limite de duração excedido… até 5 minutos (300s)» e o botão «Recortar e Guardar» fica desativado. | REQ-VID-TRIM-NF03 | ✔ |
| TST-MAN-07 | M | **Dada** uma conta gratuita, **quando** a configuração gera 81 fotogramas, **então** o diálogo indica o limite de 30, sugere «um passo de pelo menos 14 s» e desativa a submissão. | UC-VID-003/RN5 | ✔ |
| TST-MAN-08 | M | **Dada** uma extração de 0–4 s com passo 2 s para um projeto novo, **quando** termina, **então** o projeto aparece na lista sem recarregar a página; «Abrir projeto» abre-o com as imagens `long_00-00-00-000.png`, `long_00-00-02-000.png` e `long_00-00-04-000.png`; e a ferramenta Preto e Branco aplica-se às três. | UC-VID-003 | ✔ (falhava antes de `8fb6ade`, D-05) |
| TST-MAN-09 | M | **Dada** uma extração de 30 fotogramas em curso, **quando** o utilizador clica no ✕ do monitor «Tarefas de vídeo», **então** a tarefa é cancelada (a 0 de 30), o monitor fecha, não é criado projeto e o contador volta a 5. | UC-VID-003, UC-VID-004 (cancelamento) | ✔ (falhava antes de `8fb6ade`, D-06) |
| TST-MAN-10 | M | **Dadas** as 5 operações diárias esgotadas, **quando** o utilizador abre os diálogos de recorte e de extração, **então** ambos mostram «0/5 operações diárias» e a mensagem de quota esgotada com sugestão de Premium, e a submissão fica desativada. | RNG da quota diária; RNF48 (ALT) | ✔ |

## 10.3. Resumo da execução

| Nível | Executados | Passaram | Falharam | Observações |
|-------|-----------:|---------:|---------:|-------------|
| Componente — `imageStorageService` (com ffmpeg) | 58 | 58 | 0 | Executados no contentor `img_storage` |
| Gateway — `apiGateway` | 16 | 16 | 0 | — |
| Sistema (E2E) | 13 | 13 | 0 | Stack completa (30 serviços) |
| **Total automático** | **87** | **87** | **0** | — |
| Manual (interface) | 10 | 10 | 0 | Browser *headless* |
| Compilação de produção do frontend | 1 | 1 | 0 | Next.js `build`, inclui verificação de tipos TypeScript |

Durante a verificação, vários testes falharam antes das correções descritas em 10.4, e todas as
falhas corresponderam a defeitos reais:

- **Testes automáticos:** TST-TRIM-10, TST-TRIM-13, TST-FRAME-13, TST-FRAME-14 e TST-FRAME-15.
- **Teste E2E:** TST-E2E-12, na primeira execução contra a aplicação completa.
- **Testes de interface:** TST-MAN-05, TST-MAN-08 e TST-MAN-09.

Houve também três ajustes aos próprios testes, que não correspondem a defeitos do produto:

- a réplica dos modelos não aplicava os valores por omissão do esquema Mongoose;
- a tolerância de duração do recorte foi alargada (ver L-01);
- a expectativa de TST-MAN-02 foi corrigida, porque o limite de 5 ficheiros por lote é
  intencional.

## 10.4. Defeitos encontrados e corrigidos

| ID | Descrição | Impacto | Detetado por | Correção | Estado |
|----|-----------|---------|--------------|----------|--------|
| D-01 | Ao cancelar um recorte ou uma extração **em processamento**, o endpoint de cancelamento e o *worker* reembolsavam ambos a operação diária. | O utilizador gratuito ganhava uma operação extra por cada cancelamento, contornando a quota diária. | TST-TRIM-10, TST-FRAME-13 | Reembolso idempotente: a tarefa passa a ter o indicador `refunded`, reclamado de forma atómica na base de dados antes de contactar o serviço `users` (`videoTaskBilling.js`). | Corrigido (`f192dac`) |
| D-02 | Os *workers* deduziam a quota de armazenamento a partir do tamanho e da duração do vídeo, e não do perfil do utilizador. | Um utilizador Premium com um vídeo pequeno ficava limitado à quota gratuita de 1 GiB. | TST-TRIM-13, TST-FRAME-14 | O perfil passa a ser guardado na tarefa (`userType`) e a quota é obtida a partir dele. | Corrigido (`f192dac`) |
| D-03 | Um identificador de vídeo ou de tarefa malformado provocava um erro de conversão no Mongoose. As rotas com tratamento de erros respondiam 500; as rotas sem tratamento deixavam o pedido sem resposta até expirar. | Erros 500 e pedidos pendurados, com consumo de recursos do servidor. | TST-E2E-12 (1.ª execução) | Validação dos identificadores à entrada do *router*: identificadores inválidos recebem 404. Teste de regressão TST-SEC-02. | Corrigido (`85c1077`) |
| D-04 | O tempo limite da extração usava `Promise.race`, que não interrompe o processamento. Quando o limite expirava fora do ffmpeg (por exemplo, durante o envio de um fotograma), a tarefa era marcada como falhada e reembolsada, mas o processamento continuava em segundo plano. | Fotogramas órfãos no armazenamento e, consoante o momento, um projeto criado depois de a operação ter sido reembolsada. | TST-FRAME-15 | Todos os pontos de verificação passam a testar também o tempo limite, e a limpeza espera que o processamento pare antes de apagar os objetos. | Corrigido (`263904b`) |
| D-05 | Depois de um recorte ou de uma extração, o contador de operações diárias e a lista de projetos só se atualizavam ao recarregar a página. | Violava RNF48 (o contador deve atualizar-se após cada processamento); o utilizador não via o projeto criado. | TST-MAN-05, TST-MAN-08 | O fornecedor de tarefas de vídeo do frontend atualiza a sessão quando a operação é debitada, concluída, falhada ou cancelada, e invalida as consultas de projetos. | Corrigido (`8fb6ade`) |
| D-06 | O painel «Tarefas de vídeo», com o botão de cancelamento, era desenhado abaixo da área visível: o Tailwind não analisava a pasta `providers/`, pelo que a classe de posicionamento do painel não era gerada. | O utilizador não conseguia acompanhar nem cancelar tarefas (UC-VID-003/004). | TST-MAN-09 | `providers/` foi acrescentada ao `content` de `tailwind.config.ts`. | Corrigido (`8fb6ade`) |

Foram ainda identificados três problemas na solução de base, fora do âmbito do vídeo. Ficam
registados como tarefas de manutenção corretiva no Cap. 11, numeradas a seguir às tarefas T-01 a
T-11 do documento de base:

- **T-12:** o serviço `users` aceita o perfil (`type`) enviado pelo cliente no registo, permitindo
  criar uma conta Premium sem subscrição, e expõe os dados de um utilizador sem autenticação.
- **T-13:** uma rota de projetos do gateway tem a verificação de JWT por implementar (`TODO`).
- **T-14:** no `docker-compose.yaml`, o `.next` e o `node_modules` do frontend são volumes
  anónimos. Depois de reconstruir a imagem, `docker compose up` continuava a servir a versão
  anterior do frontend, o que mascarou a primeira verificação da correção de D-05. Mitigado na
  documentação, com a opção `-V` (`--renew-anon-volumes`) no README e no AGENTS.md.

## 10.5. Limitações e defeitos conhecidos

**Limitações do produto (MVP):**

| ID | Limitação | Justificação / mitigação |
|----|-----------|--------------------------|
| L-01 | O recorte sem perdas (*stream copy*) corta em fronteiras de pacote e de *keyframe*. O resultado pode ser algumas décimas de segundo mais longo do que o pedido: no teste de 2–5 s, o vídeo tem 3,08 s e o contentor reporta 3,30 s, por causa do desfasamento dos *B-frames* H.264 e do preenchimento AAC. | Opção deliberada pelo recorte sem perdas e rápido (UC-VID-004/RN6). Um corte exato exigiria recodificação, com perda de qualidade e mais tempo de processamento. |
| L-02 | As filas dos *workers* são mantidas em memória num único processo `img_storage`. As tarefas interrompidas são reagendadas no arranque, mas não há escala horizontal nem distribuição de carga. | Suficiente para o MVP. É candidata a melhoria na Fase 2 (por exemplo, migrar para RabbitMQ, já existente na arquitetura). |
| L-03 | O limite de tarefas concorrentes do recorte conta tarefas de qualquer tipo; o da extração conta só extrações. | Comportamento conforme os requisitos de cada funcionalidade (REQ-VID-TRIM-NF05 e REQ-VID-FRAME-021). A uniformização fica registada como questão em aberto. |
| L-04 | Cada lote de upload aceita no máximo 5 ficheiros; um lote de 6 é recusado na interface. | Limite intencional da interface (TST-MAN-02). |

**Questões em aberto:**

- **Q-01 — repetição após o tempo limite no recorte.** No recorte, um tempo limite conta como
  falha do *worker* e dá origem à repetição automática (REQ-VID-TRIM-NF12). No pior caso, a tarefa
  pode demorar cerca de 20 minutos antes de falhar. Na extração, o tempo limite é final, sem
  repetição (REQ-VID-FRAME-052). Se REQ-VID-TRIM-NF10 for um limite ao tempo total da tarefa, o
  recorte deve seguir o comportamento da extração. A equipa tem de confirmar a intenção do
  requisito.

**Limitações da verificação:**

- **Interface sem testes automáticos no repositório.** Os componentes React não têm testes
  unitários. A interface foi verificada pela compilação de produção (que inclui a verificação de
  tipos) e pelos cenários TST-MAN-01 a TST-MAN-10. Estes foram executados apenas em Chromium
  *headless* com uma janela de 1366×900: não foram testados outros browsers nem dispositivos
  móveis.
- **Limites de tamanho verificados sem ficheiros reais desse tamanho.** Os limites (200 MB e
  2000 MB) foram verificados com tamanhos declarados e sessões de upload. Na interface, o maior
  ficheiro enviado tinha 30 MB, por limitação da ferramenta de automação. A taxa de envio e o
  tempo estimado (ETA) não foram observados, porque os ficheiros pequenos terminam quase de
  imediato.
- **Tempo limite real não esperado.** Os limites de 10 minutos foram verificados com o tempo
  limite reduzido por configuração (`VIDEO_TASK_TIMEOUT_MS`), e não com uma tarefa real de 10
  minutos.
- **Réplicas em memória.** Os testes de componente não usam MongoDB real; operadores não
  replicados podem divergir. O risco é mitigado pelos testes E2E sobre a base de dados real.
- **Sem testes de carga.** Não foram feitos testes de desempenho nem de carga.
- **Um único ambiente.** A execução foi feita num único ambiente (Windows + Docker Desktop) e não
  num ambiente de integração contínua.
