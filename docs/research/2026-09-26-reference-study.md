# Estudo das referências e auditoria do v0 (2026-09-26)

Base para as ADRs 016–025. Commits examinados e licenças: ver tabela no fim.

## Auditoria do YandeCode v0

Stack: TypeScript/Node ≥22, monorepo npm workspaces (`core`, `retrieval`, `swarm`, `cli`, `plugin`), SQLite (better-sqlite3, FTS5), USearch HNSW, `@huggingface/transformers` (Arctic Embed XS), web-tree-sitter WASM, MCP SDK, commander. Testes: vitest, 61 arquivos / 340 testes passando.

Gaps encontrados (além dos listados na spec v1 de 2026-09-22):

| #   | Gap                                                                                                           | Evidência                                                              | Resolução                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| G1  | Hook custa ~350 ms por invocação                                                                              | medição: `yandecode hook PostToolUse` 342–361 ms vs `node -e ""` 27 ms | carregamento preguiçoso por comando e por módulo (ADR-025)                             |
| G2  | `usearch` recursa infinitamente ao ser importado fora do diretório esperado                                   | `RangeError` em `getBuildDir`                                          | remover USearch; vetores de conhecimento (corpus pequeno) em busca exata (ADR-020/025) |
| G3  | Tudo é instalado sempre: 7 agentes, 4 skills, 6 hooks, 1 servidor MCP com ~17 ferramentas                     | `runInit` materializa listas fixas (`plugin-content.ts`)               | sistema de módulos com integração gerada (ADR-016)                                     |
| G4  | Busca semântica de código com baixa relevância (scores 0.016–0.052) e índice constantemente sujo              | spec v1 §Contexto                                                      | navegação estrutural + BM25 + roteador de consulta (ADR-017)                           |
| G5  | Nenhum `PreToolUse`: saídas volumosas entram inteiras no contexto; nenhuma proteção contra comandos perigosos | `hooks.json`                                                           | módulos `context` e `guard` (ADR-019/022)                                              |
| G6  | Memória em SQLite opaca; `recordUsage()` sem chamador; nada é injetado na sessão seguinte                     | ADR-011, `memory-service.ts`                                           | memória em Markdown + ciclo de vida + divulgação progressiva (ADR-020)                 |
| G7  | Contexto injetado no SessionStart sem orçamento                                                               | `sessionStartContext`                                                  | orçamento de 8 000 chars por hook (limite do Claude Code: 10 000)                      |
| G8  | Swarm com cenários de travamento documentados e sem uso real                                                  | spec v1 D3, skill `yandecode-swarm-protocol`                           | swarm removido; delegação via subagentes nativos + workflow persistente (ADR-024)      |
| G9  | Download de modelo do Hugging Face obrigatório para indexar                                                   | spec v1                                                                | indexação de código sem rede; embeddings opcionais (ADR-025)                           |
| G10 | Instalação limpa depende de publicar 5 pacotes `@yandecode/*` coordenados                                     | `package.json` dos workspaces                                          | pacote único distribuível validado por `npm pack` em prefixo limpo (tarefa T-INST)     |

## Referências: o que cada uma resolve e como

**Serena** — ferramentas simbólicas sobre LSP: `find_symbol(name_path_pattern, relative_path, depth, include_body, substring_matching)`, `get_symbols_overview`, `find_referencing_symbols`, `replace_symbol_body`/`insert_after_symbol` com diagnósticos antes/depois da edição, e `max_answer_chars` em toda resposta. SolidLSP instala servidores de linguagem sob demanda (ex.: `npm install typescript-language-server` num diretório próprio). Memórias = arquivos Markdown por projeto.
→ Adotamos: `name_path` (`Classe/metodo`), orçamento por resposta, instalação gerenciada do servidor, diagnósticos pós-edição. Rejeitamos: edição simbólica (as ferramentas Edit nativas do Claude Code já são boas; duplicar amplia a superfície).

**Context Mode** (ELv2 — só comportamento) — `ctx_execute`/`ctx_batch_execute` executam comandos fora do contexto, guardam a saída completa em FTS5 e devolvem resumo; `ctx_search` recupera trechos; `ctx_fetch_and_index` para URLs. Hooks `PreToolUse` em Bash/WebFetch/Read/Grep: bloqueia `curl`/`wget`/HTTP inline (deny com instrução — Claude Code ignora `updatedInput.command`), e para o resto injeta orientação uma vez / periodicamente.
→ Adotamos: execução isolada com armazenamento integral e busca posterior (fontes nunca perdidas), deny-com-instrução só para casos de alta confiança, orientação uma vez por sessão.

**Claude-Mem** — hooks capturam observações; worker LLM comprime; injeção no SessionStart por orçamento medido (renderiza, se passar do limite descarta o item mais caro e re-renderiza); busca em 3 camadas: `search` (índice compacto) → `timeline` → `get_observations(ids)` → `get_tool_uses` (bruto).
→ Adotamos: divulgação progressiva (índice → itens → fonte), ajuste por medição, fonte original preservada. Rejeitamos: worker LLM obrigatório para cada observação (custo e latência; observações determinísticas + consolidação explícita).

**Superpowers** (MIT) — biblioteca de skills: brainstorming, writing-plans, executing-plans, TDD, systematic-debugging, verification-before-completion, requesting/receiving-code-review, subagent-driven-development.
→ Adaptamos um subconjunto enxuto como skills do módulo `workflow`, com atribuição.

**OpenSpec** (MIT) — mudanças em `openspec/changes/<id>/` com `proposal.md`, `design.md`, `tasks.md`, `specs/<cap>/spec.md` (deltas `## ADDED|MODIFIED|REMOVED Requirements`, `#### Scenario:`), archive que funde deltas nas specs.
→ Adotamos o formato de change para o workflow persistente (retomável após interrupção), com estado derivado dos artefatos físicos.

**claude-plugins-official** — `code-review`: agentes paralelos + pontuação de confiança 0–100 com corte em 80 para evitar falsos positivos. `security-guidance`: padrões regex em `PostToolUse` de edição (workflow do GitHub Actions, `eval`, `pickle`, `yaml.load`, `innerHTML`…) e revisão LLM no Stop/commit. `claude-md-management`: auditoria de qualidade do CLAUDE.md. `*-lsp`: só declaram `lspServers` (binário deve estar no PATH).
→ Adotamos pipeline de revisão com corte de confiança, padrões determinísticos em edição, auditoria de instruções determinística. LSP: cliente próprio porque integração materializada no projeto não declara `lspServers`.

**jev-kit** (MIT) — AIRLOCK: tabela de regras barata primeiro, juiz LLM só nos ambíguos, fail-open, orçamento de tempo, carimbo `[airlock-ok: motivo]`, proteção contra loop de negações, redação antes de truncar.
→ Adotamos a parte determinística. Juiz LLM rejeitado (ADR-022).

**Context7** — removido por decisão do usuário; doc de dependência é local (ADR-021).

| Projeto                            | Commit  | Licença                        |
| ---------------------------------- | ------- | ------------------------------ |
| oraios/serena                      | 7a29683 | GPL-3.0 (app) / MIT (SolidLSP) |
| mksglu/context-mode                | 6c8dbf2 | Elastic-2.0                    |
| thedotmack/claude-mem              | 7d03554 | Apache-2.0                     |
| obra/superpowers                   | 8ca22db | MIT                            |
| Fission-AI/OpenSpec                | 79b6aa9 | MIT                            |
| anthropics/claude-plugins-official | fa59bc9 | Apache-2.0                     |
| jonathanavis96/jev-kit             | 9ecc54f | MIT                            |
