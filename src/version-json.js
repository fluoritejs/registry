export function versionJson(v, options = {}) {
  const meta = JSON.parse(v.meta_json || "{}");
  const result = {
    version: v.version,
    status: v.status,
    createdAt: v.created_at,
    publishedAt: v.published_at,
    yanked: !!v.yanked,
    yankReason: v.yank_reason || null,
    downloads: v.downloads,
    ...(meta.id
      ? {
          id: meta.id,
          name: meta.name,
          license: meta.license,
          description: meta.description,
        }
      : {}),
  };
  if (options.includeNamespace) {
    result.namespace = v.namespace;
    result.extensionId = v.package_id;
  }
  return result;
}
