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
| **Componente — *workers*** | *Workers* de metadados, recorte e extração de fotogramas | **ffmpeg/ffprobe** sobre vídeos gerados no momento do teste | MongoDB, S3 e os serviços `users` e `projects` | 21 |
| **Gateway** | Rotas de vídeo do `apiGateway` | Verificação de JWT, débito e reembolso de operações | Serviços `users` e `imageStorageService` | 16 |
| **Sistema (E2E)** | Aplicação completa através do ponto de entrada público (nginx) | Todos os serviços, as bases de dados e o SeaweedFS | Nada | 13 |
| **Manual** | Interface web (`https://localhost:8080`) | Tudo | Nada | 10 |

Princípios seguidos:

- **Limites testados nas fronteiras.** Cada limite por perfil é testado no valor permitido e no
  valor imediatamente acima (por exemplo, 300 s e 300,5 s de recorte no perfil gratuito), para os
  dois perfis.
- **Media real.** Os testes dos *workers* não simulam o ffmpeg. Geram clips sintéticos (MP4
  H.264+AAC, MOV H.264, WebM VP9+Opus, MP4 MPEG-4 Part 2, um WebM renomeado para `.mp4` e um ficheiro
  corrompido) e verificam o resultado com ffprobe.
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

### Ambiente

| Elemento | Versão |
|----------|--------|
| Sistema anfitrião | Windows 11, Docker Desktop 4.45 (Docker Engine 28.3.3, WSL 2) |
| Node.js (anfitrião) | 22.19 |
| Imagem `img_storage` | Node.js 20, ffmpeg do Debian bookworm |
| Base de dados | MongoDB 4.4 |
| Armazenamento de objetos | SeaweedFS 4.47 (API S3) |
| Código testado | Branch `feat/fase1-testes-evidencias`, *commit* `6bcd3fc` |
| Data da execução | 18 de outubro de 2026 |

As instruções para reproduzir todas as execuções estão no Anexo (Instruções de execução dos
testes).

## 10.2. Testes realizados

Legenda — **Tipo**: C = componente, C+ff = componente com ffmpeg real, GW = gateway, E2E =
sistema, M = manual. **Resultado**: ✔ passou na execução final; «falhava antes de …» indica que
o teste detetou um defeito (ver 10.4) e passou depois da correção.

### 10.2.1. Submeter vídeo e biblioteca (UC-VID-001, UC-VID-002)

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
| TST-LIB-01 | C | **Dados** vídeos de vários utilizadores e em vários estados, **quando** um utilizador consulta a biblioteca, **então** vê apenas os seus vídeos `ready`, cada um com URL de reprodução. | UC-VID-002; RNF44 (ALT) | ✔ |
| TST-LIB-02 | C | **Dado** um vídeo de outro utilizador, **quando** se tenta apagá-lo, **então** nada acontece; apagar um vídeo próprio remove o objeto e o registo. | UC-VID-002; RNF44 (ALT) | ✔ |

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
| TST-TRIM-10 | C+ff | **Dado** um recorte em processamento, **quando** o utilizador cancela, **então** a tarefa fica `cancelled`, não é criado vídeo e a operação é reembolsada **exatamente uma vez**. | UC-VID-004 (cancelamento) | ✔ (falhava antes de `9b79646`, D-01) |
| TST-TRIM-11 | C | **Dado** um recorte em fila, **quando** é cancelado, **então** o ffmpeg não chega a ser executado e há um único reembolso. | UC-VID-004 (cancelamento) | ✔ |
| TST-TRIM-12 | C | **Dada** uma falha do *worker* (origem indisponível), **quando** o recorte é executado, **então** há uma repetição automática, depois a tarefa fica `failed`, a operação é reembolsada e os temporários são removidos. | REQ-VID-TRIM-NF12 | ✔ |
| TST-TRIM-13 | C+ff | **Dada** uma quota de armazenamento cheia, **quando** o recorte termina, **então** um utilizador gratuito recebe «Armazenamento insuficiente» com reembolso, e um Premium com a mesma utilização conclui. | UC-VID-004 (exceção: armazenamento cheio) | ✔ (falhava antes de `9b79646`, D-02) |

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
| TST-FRAME-13 | C | **Dada** uma extração em processamento, **quando** o utilizador cancela, **então** a tarefa fica `cancelled`, não é criado projeto e há **exatamente um** reembolso. | UC-VID-003 (cancelamento) | ✔ (falhava antes de `9b79646`, D-01) |
| TST-FRAME-14 | C+ff | **Dada** uma quota de armazenamento cheia, **quando** a extração termina, **então** um gratuito falha e um Premium com a mesma utilização conclui. | REQ-VID-FRAME-051 | ✔ (falhava antes de `9b79646`, D-02) |

### 10.2.4. Acompanhar tarefas, autenticação e quota diária (transversal)

Estes requisitos são comuns aos três casos de uso. Por isso são verificados uma só vez.

| ID | Tipo | Descrição (Dado … Quando … Então) | Requisitos | Resultado |
|----|------|-----------------------------------|------------|-----------|
| TST-STATUS-01 | C | **Dadas** tarefas em vários estados e de vários utilizadores, **quando** um utilizador lista as suas tarefas, **então** obtém apenas as próprias em `queued` ou `processing`. | UC-VID-003, UC-VID-004 (acompanhar tarefa) | ✔ |
| TST-STATUS-02 | C | **Dada** uma tarefa de outro utilizador, **quando** é consultada, **então** a resposta é 404. | RNF44 (ALT) | ✔ |
| TST-STATUS-03 | C | **Dadas** uma tarefa de recorte e uma de extração, **quando** são canceladas, **então** cada cancelamento é tratado pelo *worker* do tipo correspondente. | UC-VID-003, UC-VID-004 | ✔ |
| TST-SEC-01 | C | **Dado** um pedido aos serviços internos sem *token* de serviço, ou com um *token* errado, **quando** chega, **então** é recusado (403). | RNF44 (ALT) | ✔ |
| TST-SEC-02 | C | **Dado** um identificador de vídeo ou de tarefa malformado, **quando** é usado em qualquer rota, **então** a resposta é 404. | Robustez | ✔ (corrigido em `6bcd3fc`, D-03) |
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
| TST-E2E-02 | E2E | **Dados** MP4, MOV e WebM válidos, **quando** são enviados em partes de 8 MiB, **então** ficam `ready` com metadados, aparecem na biblioteca e o contador de operações não muda. | UC-VID-001, UC-VID-002 | ✔ |
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
navegação durante uploads, mensagens ao utilizador e contadores).

| ID | Tipo | Descrição (Dado … Quando … Então) | Requisitos | Resultado |
|----|------|-----------------------------------|------------|-----------|
| TST-MAN-01 | M | **Dados** um MP4, um MOV e um WebM, **quando** são arrastados para a biblioteca, **então** são mostrados o progresso, a taxa e a estimativa de tempo, e cada vídeo aparece com duração e resolução. | UC-VID-001, UC-VID-002 | {a preencher} |
| TST-MAN-02 | M | **Dado** um lote de 6 ficheiros em envio, **quando** o utilizador navega para outra página do dashboard, **então** os uploads continuam. | UC-VID-001 | {a preencher} |
| TST-MAN-03 | M | **Dado** um upload grande em curso, **quando** é cancelado, **então** o envio para e o vídeo não aparece na biblioteca. | UC-VID-001 | {a preencher} |
| TST-MAN-04 | M | **Dado** um `.txt` renomeado para `.mp4`, **quando** é enviado, **então** é mostrada uma mensagem de erro e o ficheiro não aparece na biblioteca. | UC-VID-001 | {a preencher} |
| TST-MAN-05 | M | **Dado** um vídeo pronto, **quando** é recortado com e sem «Substituir original», **então** a duração do segmento é atualizada ao mover os cursores, a tarefa aparece no monitor, o resultado aparece na biblioteca e o contador desce 1. | UC-VID-004; RNF48 (ALT) | {a preencher} |
| TST-MAN-06 | M | **Dada** uma conta gratuita, **quando** é selecionado um segmento acima de 300 s, **então** o diálogo impede a submissão e explica o limite. | REQ-VID-TRIM-NF03 | {a preencher} |
| TST-MAN-07 | M | **Dada** uma conta gratuita, **quando** a configuração gera mais de 30 fotogramas, **então** é sugerido o passo mínimo. | UC-VID-003/RN5 | {a preencher} |
| TST-MAN-08 | M | **Dada** uma extração para um projeto novo, **quando** termina e o utilizador abre o projeto pelo link, **então** as imagens têm nomes `<vídeo>_<hh-mm-ss-mmm>` e as ferramentas de imagem aplicam-se normalmente. | UC-VID-003 | {a preencher} |
| TST-MAN-09 | M | **Dada** uma tarefa em curso, **quando** é cancelada no monitor, **então** passa a «cancelado» e o contador de operações é reposto. | UC-VID-003, UC-VID-004 | {a preencher} |
| TST-MAN-10 | M | **Dadas** as 5 operações diárias esgotadas, **quando** o utilizador tenta outra operação, **então** vê a mensagem de quota diária e a sugestão de Premium. | RNG da quota diária | {a preencher} |

## 10.3. Resumo da execução

| Nível | Executados | Passaram | Falharam | Observações |
|-------|-----------:|---------:|---------:|-------------|
| Componente — `imageStorageService` (com ffmpeg) | 54 | 54 | 0 | Executados no contentor `img_storage` |
| Gateway — `apiGateway` | 16 | 16 | 0 | — |
| Sistema (E2E) | 13 | 13 | 0 | Stack completa (30 serviços) |
| **Total automático** | **83** | **83** | **0** | — |
| Manual | 10 | {…} | {…} | {a preencher pela equipa} |

Durante o desenvolvimento dos testes, quatro testes automáticos falharam antes das correções
descritas em 10.4 (TST-TRIM-10, TST-TRIM-13, TST-FRAME-13 e TST-FRAME-14). Um teste E2E
(TST-E2E-12) falhou na primeira execução contra a aplicação completa. Todas as falhas
corresponderam a defeitos reais e não a erros dos testes. Houve ainda dois ajustes aos próprios
testes, que não correspondem a defeitos do produto:

- a réplica dos modelos não aplicava os valores por omissão do esquema Mongoose;
- a tolerância de duração do recorte foi alargada, pelas razões explicadas em L-01.

## 10.4. Defeitos encontrados e corrigidos

| ID | Descrição | Impacto | Detetado por | Correção | Estado |
|----|-----------|---------|--------------|----------|--------|
| D-01 | Ao cancelar um recorte ou uma extração **em processamento**, o endpoint de cancelamento e o *worker* reembolsavam ambos a operação diária. | O utilizador gratuito ganhava uma operação extra por cada cancelamento, contornando a quota diária. | TST-TRIM-10, TST-FRAME-13 | Reembolso idempotente: a tarefa passa a ter o indicador `refunded`, reclamado de forma atómica na base de dados antes de contactar o serviço `users` (`videoTaskBilling.js`). | Corrigido (`9b79646`) |
| D-02 | Os *workers* deduziam a quota de armazenamento a partir do tamanho e da duração do vídeo, e não do perfil do utilizador. | Um utilizador Premium com um vídeo pequeno ficava limitado à quota gratuita de 1 GiB. | TST-TRIM-13, TST-FRAME-14 | O perfil passa a ser guardado na tarefa (`userType`) e a quota é obtida a partir dele. | Corrigido (`9b79646`) |
| D-03 | Um identificador de vídeo ou de tarefa malformado provocava um erro de conversão no Mongoose. As rotas com tratamento de erros respondiam 500; as rotas sem tratamento deixavam o pedido sem resposta até expirar. | Erros 500 e pedidos pendurados, com consumo de recursos do servidor. | TST-E2E-12 (1.ª execução) | Validação dos identificadores à entrada do *router*: identificadores inválidos recebem 404. Teste de regressão TST-SEC-02. | Corrigido (`6bcd3fc`) |

Foram ainda identificados dois problemas na solução de base, fora do âmbito do vídeo. Ficam
registados como tarefas de manutenção corretiva no Cap. 11, numeradas a seguir às tarefas
T-01 a T-11 do documento de base:

- **T-12:** o serviço `users` aceita o perfil (`type`) enviado pelo cliente no registo, permitindo
  criar uma conta Premium sem subscrição, e expõe os dados de um utilizador sem autenticação.
- **T-13:** uma rota de projetos do gateway tem a verificação de JWT por implementar (`TODO`).

## 10.5. Limitações e defeitos conhecidos

**Limitações do produto (MVP):**

| ID | Limitação | Justificação / mitigação |
|----|-----------|--------------------------|
| L-01 | O recorte sem perdas (*stream copy*) corta em fronteiras de pacote e de *keyframe*. O resultado pode ser algumas décimas de segundo mais longo do que o pedido: no teste de 2–5 s, o vídeo tem 3,08 s e o contentor reporta 3,30 s, por causa do desfasamento dos *B-frames* H.264 e do preenchimento AAC. | Opção deliberada pelo recorte sem perdas e rápido (UC-VID-004/RN6). Um corte exato exigiria recodificação, com perda de qualidade e mais tempo de processamento. |
| L-02 | As filas dos *workers* são mantidas em memória num único processo `img_storage`. As tarefas interrompidas são reagendadas no arranque, mas não há escala horizontal nem distribuição de carga. | Suficiente para o MVP. É candidata a melhoria na Fase 2 (por exemplo, migrar para RabbitMQ, já existente na arquitetura). |
| L-03 | O limite de tarefas concorrentes do recorte conta tarefas de qualquer tipo; o da extração conta só extrações. | Comportamento conforme os requisitos de cada funcionalidade (REQ-VID-TRIM-NF05 e REQ-VID-FRAME-021). A uniformização fica registada como questão em aberto. |

**Limitações da verificação:**

- **Interface sem testes automáticos.** Os componentes React não têm testes automáticos. São
  verificados pela compilação de produção (verificação de tipos) e pelos testes manuais
  TST-MAN-01 a TST-MAN-10.
- **Tempo limite de 10 minutos não exercitado.** O cancelamento por tempo limite
  (REQ-VID-TRIM-NF10, REQ-VID-FRAME-052) está implementado mas não foi testado, porque exigiria
  vídeos de grande dimensão ou a parametrização do limite. Fica **por verificar**.
- **Rotação não verificada na extração.** A aplicação da rotação dos metadados aos fotogramas
  extraídos não foi verificada com um vídeo rodado. Os clips de teste não têm rotação.
- **Réplicas em memória.** Os testes de componente não usam MongoDB real; operadores não
  replicados podem divergir. O risco é mitigado pelos testes E2E sobre a base de dados real.
- **Sem testes de carga.** Não foram feitos testes de desempenho, de carga nem de ficheiros
  próximos dos limites reais (2 GB). Os limites foram verificados com tamanhos declarados e com
  sessões de upload, não com ficheiros completos desse tamanho.
- **Um único ambiente.** A execução foi feita num único ambiente (Windows + Docker Desktop) e não
  num ambiente de integração contínua.
