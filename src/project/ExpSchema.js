/**
 * @flow
 */

import Api from '../Api';

let _xdlSchemaJson = {};

export async function getSchemaAsync(sdkVersion) {
  let json = await _getSchemaJSONAsync(sdkVersion);
  return json.schema;
}

// Array of schema nodes that refer to assets along with their field
// path (eg. 'notification.icon')
export async function getAssetSchemasAsync(sdkVersion) {
  const schema = await getSchemaAsync(sdkVersion);
  const assetSchemas = [];
  const visit = (node, fieldPath) => {
    if (node.meta && node.meta.asset) {
      assetSchemas.push({ schema: node, fieldPath });
    }
    const properties = node.properties;
    if (properties) {
      Object.keys(properties).forEach((property) =>
        visit(properties[property], `${fieldPath}${fieldPath.length > 0 ? '.' : ''}${property}`));
    }
  }
  visit(schema, '');
  return assetSchemas;
}

async function _getSchemaJSONAsync(sdkVersion) {
  if (!_xdlSchemaJson[sdkVersion]) {
    _xdlSchemaJson[sdkVersion] = await Api.xdlSchemaAsync(sdkVersion);
  }

  return _xdlSchemaJson[sdkVersion];
}
