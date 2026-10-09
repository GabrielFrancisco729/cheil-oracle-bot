# Contrato de métricas

Versão: `dax-docx-2026-10-09`. Referência original: `reference/Metricas-BIG-Numbers.docx`.

`public/metric-contract.js` contém o catálogo e o cálculo dos componentes. `lib/metrics.js` traduz o contrato para SQL e `lib/data.js` aplica os filtros de subsidiária, período e moeda. Chat e resumos utilizam esse mesmo SQL; o assistente de relatório usa o mesmo catálogo. Os criativos de demonstração usam componentes simulados e a função compartilhada de cálculo.

## Regras disponíveis e implementadas

| Indicador | Regra do documento | Observações |
| --- | --- | --- |
| Deliveries | `SUM(DELIVERED)` | Mantém o filtro de produto |
| Opens | `SUM(OPENS)` | Remove filtros de `dProducts` |
| Clicks | `SUM(CLICKS)` | Remove filtros de `dProducts` |
| Visits | `VisitsAll - VisitsAffiliate + VisitsAffiliate * 0.044` | Ambas as parcelas removem filtros de `dProducts` |
| Units | `UnitsAll - UnitsAffiliate + UnitsAffiliate * 0.044` | Mantém o filtro de produto |
| Revenue | `AA + VTEX + APP + WPAPP + GA4 + Affiliate * 0.044 - Affiliate` | Não arredonda antes de exibir |
| OR% | `Opens / Deliveries` de `fConsolidated.CHANNEL IN ('EMAIL', 'WHATSAPP')` | Só divide se Deliveries > Opens, senão retorna 0; o numerator usa `tOpens` com remoção de filtro de produto |
| CTOR% | `Clicks / Opens` de `fConsolidated.CHANNEL IN ('EMAIL', 'WHATSAPP')` | Só divide se Opens > Clicks, senão retorna 0; ambos removem filtro de produto |
| CTR% | `tClicks / tDeliveries` | O DAX retorna `CTR2`; as variáveis `mailClicks/mailDeliveries` anteriores não são utilizadas no retorno |

O SQL mantém as parcelas de receita separadas, mesmo quando as condições se sobrepõem, reproduzindo a composição fornecida:

- AA: `Source = 'ANALYTICS'`.
- VTEX: `Source = 'VTEX'`.
- APP: `dAllDimensions.CHANNEL = 'APP PUSH'`.
- WPAPP: `fConsolidated.CHANNEL = 'WEB PUSH' AND Source = 'APP'`.
- GA4: `LEFT(Source, 9) = 'GA4_SEASA'`. Usa sempre `Revenue`, inclusive em BRL.
- Affiliate: `DATA_SOURCE = 'AFFILIATE'`. Usa sempre `Revenue`, inclusive em BRL.
- As quatro primeiras parcelas usam `Revenue_SEDA` quando a opção BRL está selecionada no recorte exclusivo SEDA; nos demais casos usam `Revenue`.

A UI não chama a moeda padrão de USD nem faz câmbio novo. A hipótese de recorte exclusivo SEDA para BRL precisa ser conferida contra as definições de `currencySEDAselecionado` e `currencyMOEDAselecionado`, ausentes no documento.

Em agrupamentos por produto, Opens, Clicks, Visits e suas parcelas de email/affiliate são calculadas sem o grupo produto e repetidas nas linhas. Isso é intencional para reproduzir `REMOVEFILTERS(dProducts)`. Esses valores não podem ser somados entre produtos.

## Orders, CVR e AOV reais: pendências

O DOCX referencia `[tOrdersGA4]`, mas não fornece a fórmula dessa medida. Também calcula OrdersAppsFlyer a partir de `auxOrderIDPerDate[ORDERS_BY_ORDERID]`, sob filtros de `fConsolidated`, sem fornecer o schema e os relacionamentos que propagam esses filtros.

Essas informações são necessárias para traduzir os cálculos com fidelidade:

1. Fórmula completa de `tOrdersGA4`.
2. Nome/schema da tabela `auxOrderIDPerDate` no BigQuery, caso exista.
3. Chaves, cardinalidade, direção e relações ativas entre essa tabela, `fConsolidated` e as dimensões de data, produto e campanha.
4. Regras de `currencySEDAselecionado` e `currencyMOEDAselecionado` para conferir a seleção da receita local.

Na ausência das definições de pedidos, o SQL retorna `NULL` para Orders, CVR e AOV. Esses indicadores aparecem como pendentes no catálogo e na interface; o prompt proíbe reconstruí-los com somas aproximadas. Não houve substituição por `SUM(Total_orders)` ou `Orders / Total_visits`.

As parcelas já documentadas foram preservadas para completar o adaptador depois:

- Orders CRM: AppsFlyer + Insider + CRM + VTEX + GA4 + Affiliate × 0.044 − Affiliate.
- Insider em Orders inclui `IOS`, `ANDROID`, `APP`, `ARQUITECT`, `ARCHITECT`, `EPP` ou `CHANNEL / TRIGGER = 'APP PUSH'`.
- Insider em `tOrdersCRM_withVisits` não inclui `ARCHITECT` explicitamente, respeitando a diferença entre as duas fórmulas do DOCX.
- `tOrdersCRM_withVisits`: AppsFlyer + Insider + CRM + GA4 − VTEX_CARTAPP − Affiliate.
- CVR divide esse numerador por `[tVisits] - [tVisits] no recorte affiliate`, com retorno alternativo 0. O denominador corresponde às visitas não affiliate, e não ao total ajustado de visitas.
- AOV: Revenue / Orders, sem retorno alternativo explícito.

## Conciliação necessária no ambiente real

Os testes verificam as fórmulas disponíveis com fixtures conhecidas, limites de OR/CTOR, efeitos de produto e serialização do SDK. Isso não substitui uma conciliação com o Power BI.

A implementação presume a relação já usada pelo app: `fConsolidated.Tracking_code = dAllDimensions.TrackingCode` e `fConsolidated.Product = dProducts.SKU`. Escolhe uma dimensão completa determinística por TrackingCode e o menor PRODUCT por SKU para evitar multiplicar fatos. Se o modelo usar outra chave ou tiver duplicatas conflitantes, deve-se aplicar a regra oficial em vez desse desempate.

Os campos `CHANNEL`, `CHANNEL / TRIGGER`, `Revenue` e `Revenue_SEDA` de `fConsolidated` devem existir no BigQuery, além dos campos já utilizados na versão anterior. Se forem colunas calculadas somente no Power BI, é necessário disponibilizar as mesmas regras no BigQuery ou mapear uma view equivalente.

O protótipo Best x Worst nunca consulta dados reais. O cálculo de CVR dos exemplos recebe componentes de pedidos completos e simulados; ele não resolve as dependências do ambiente de produção. O relatório nesta versão gera apenas cabeçalhos CSV e não exporta valores de negócio.
