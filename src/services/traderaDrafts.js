function amount(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

export function buildTraderaDraft(record, input = {}) {
  if (!record?.product?.title) throw new Error('Inventory record has no product snapshot.');
  const title = String(input.title ?? record.product.title).trim().slice(0, 80);
  const askingPriceSek = amount(
    input.askingPriceSek,
    record.product.projectedResaleSek ?? record.salePriceSek ?? record.purchasePriceSek
  );
  if (!title || askingPriceSek <= 0) {
    throw new Error('Draft requires a title and positive asking price.');
  }

  const condition = String(input.condition ?? 'Used - very good').trim().slice(0, 120);
  const description = String(input.description ?? [
    title,
    '',
    `Condition: ${condition}`,
    record.notes ? `Notes: ${record.notes}` : '',
    '',
    'The listing is reviewed and published manually.'
  ].filter(Boolean).join('\n')).trim().slice(0, 5000);

  return {
    externalReference: record.id,
    title,
    description,
    askingPriceSek,
    condition,
    categoryId: input.categoryId == null ? null : String(input.categoryId).trim(),
    imageUrls: [record.product.imageUrl].filter(Boolean),
    sourceUrl: record.product.url ?? null,
    publish: false
  };
}

export async function submitTraderaDraft(draft, config, fetchImpl = fetch) {
  const endpoint = String(config?.draftEndpoint ?? '').trim();
  const accessToken = String(config?.accessToken ?? '').trim();
  if (!endpoint || !accessToken) {
    throw new Error('Tradera draft submission is not configured.');
  }
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': draft.externalReference
    },
    body: JSON.stringify(draft),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Tradera draft API failed (${response.status}): ${detail || response.statusText}`);
  }
  return response.json();
}
