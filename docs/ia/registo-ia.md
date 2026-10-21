# Registo de utilização de agentes de IA — Fase 1

Evidência para o Cap. 9 do relatório (Implementação assistida por agentes de IA). Cada entrada
indica a ferramenta, o pedido (prompt), o que foi produzido, como a equipa validou e o commit.

## Ferramentas e configuração

| Elemento | Onde | Função |
|----------|------|--------|
| Claude Code (Opus 5.5), extensão VS Code | — | Agente principal: leitura do repositório, geração e alteração de código, testes, execução da stack |
| Instruções de projeto | [`AGENTS.md`](../../AGENTS.md) | Arquitetura, desenho do upload/recorte/extração, regras de implementação e validação; lido automaticamente pelo agente |
| Skill `picturas-video-operation` | [`.claude/skills/picturas-video-operation/SKILL.md`](../../.claude/skills/picturas-video-operation/SKILL.md) | Procedimento para acrescentar/alterar uma operação de vídeo em todas as camadas |
| Skill `picturas-video-tests` | [`.claude/skills/picturas-video-tests/SKILL.md`](../../.claude/skills/picturas-video-tests/SKILL.md) | Como escrever e correr testes (fakes, ffmpeg, IDs TST, registo de resultados) |
| Skill `picturas-traceability` | [`.claude/skills/picturas-traceability/SKILL.md`](../../.claude/skills/picturas-traceability/SKILL.md) | Construção/verificação da cadeia caso de uso → requisito → componente → teste |

## Tarefas apoiadas

> **A completar pela equipa:** acrescentar as sessões anteriores (upload, recorte, extração,
> dashboard), com o prompt principal, o commit e quem validou. Os commits de partida são
> `57d97d5` (upload), `2258ab3` (recorte), `96ae6d6` (extração) e `96f6b84` (dashboard).

| # | Data | Tarefa | Prompt (resumo) | Resultado | Validação pela equipa | Commit / PR |
|---|------|--------|-----------------|-----------|-----------------------|-------------|
| 1 | 2026-10-18 | Análise do que faltava para a entrega | «Que falta fazer sem ser relatorio e diagramas?» (com as diretrizes da Fase 1 e o enunciado) | Lista de lacunas: testes, evidências de IA, `grupo.csv`, README, empacotamento | Revisão da lista pela equipa | — |
| 2 | 2026-10-18 | Testes automáticos, correções, skills, README, execução da stack | «Faz isso por essa ordem e corre o picturas para eu ver, faz numa branch…» | Branch `feat/fase1-testes-evidencias`: testes (`node:test`), 2 defeitos corrigidos, 3 skills, E2E, README, catálogo de testes | Ver [`docs/testes-fase1.md`](../testes-fase1.md): execução dos testes, revisão do diff, verificação manual na aplicação | ver `git log feat/fase1-testes-evidencias` |
| 3 | 2026-10-21 | Verificar o que faltava (IDs dos UC, tempo limite, rotação, testes de interface) | «Ainda podemos verificar coisas que ainda não tenham sido, temos tempo; entretanto verifica as 3 coisas que me disseste» | Correção UC-VID-002 → UC-VID-001 nos testes; testes de tempo limite e rotação; 10 cenários de interface num browser *headless*; 3 defeitos corrigidos (D-04 a D-06); Cap. 10 atualizado | Execução dos testes (58 + 16 + 13), compilação do frontend, capturas de ecrã dos cenários de interface | `263904b`, `8fb6ade` |

## Defeitos encontrados com apoio da IA

| ID | Descrição | Como foi detetado | Correção |
|----|-----------|-------------------|----------|
| D-01 | Cancelar uma tarefa de recorte/extração **em processamento** reembolsava a operação diária **duas vezes** (endpoint de cancelamento e worker), dando ao utilizador uma operação extra | Revisão do código dos workers; reproduzido por TST-TRIM-10 / TST-FRAME-13 | `services/videoTaskBilling.js`: reembolso idempotente com a flag `refunded` reclamada atomicamente |
| D-02 | Nos workers, a quota de armazenamento era inferida do tamanho/duração do vídeo; um utilizador Premium com um vídeo pequeno ficava limitado à quota gratuita (1 GiB) | Revisão do código; reproduzido por TST-TRIM-13 / TST-FRAME-14 | `userType` persistido na `VideoTask` e `videoStorageQuota(task.userType)` |
| D-03 | ID malformado nas rotas de vídeo dava 500 ou deixava o pedido pendurado | Teste E2E TST-E2E-12 contra a stack real | `router.param` valida `videoId`/`taskId` e responde 404 |
| D-04 | O tempo limite da extração (`Promise.race`) não parava o processamento: deixava fotogramas órfãos e podia criar o projeto depois do reembolso | Novo teste TST-FRAME-15 com tempo limite configurável | Verificação do tempo limite em todos os pontos de controlo; a limpeza espera pelo processamento |
| D-05 | O contador de operações e a lista de projetos só se atualizavam ao recarregar a página (RNF48) | Cenários de interface TST-MAN-05/08 num browser *headless* | O fornecedor de tarefas atualiza a sessão e invalida as consultas de projetos |
| D-06 | O painel «Tarefas de vídeo» ficava fora do ecrã: o Tailwind não analisava `providers/` | Cenário TST-MAN-09 (o botão de cancelar estava fora da área visível) e captura de ecrã | `providers/` acrescentada a `tailwind.config.ts` |

## Análise crítica (notas para o relatório)

- O agente acelerou sobretudo tarefas repetitivas e transversais (testes de limites, *fakes*,
  documentação), mas as decisões de domínio (limites, regras de quota) vieram do documento de
  requisitos; o agente foi instruído a não inventar valores.
- Erros do agente detetados pela equipa/testes: *fake* de modelo sem *defaults* do esquema
  Mongoose (teste TST-UPLOAD-01 falhou na 1.ª execução); teste E2E de cancelamento inicialmente
  sujeito a corrida (o recorte com *stream copy* termina em < 1 s), reescrito para cancelar uma
  tarefa em fila.
- Os testes de interface conduzidos pelo agente encontraram dois defeitos (D-05, D-06) que os testes
  de API não podiam apanhar. A primeira verificação de D-05 falhou por um problema de
  infraestrutura (T-14: volume anónimo `.next`), que o agente diagnosticou antes de concluir que a
  correção estava errada.
- Todo o código gerado foi revisto e testado antes do merge; a equipa é responsável pelo conteúdo.
