/**
 * Node ids. They depend only on the project, qualified names and parameter types (never on the folder that was
 * analyzed), so the same code gets the same ids whether one folder or the whole repository is mapped.
 *
 *   cpp:project:shop_domain
 *   cpp:ns:shop_domain/shop::orders          a C++ namespace
 *   cpp:ns:shop_domain/net/                  code outside any namespace, by folder
 *   cpp:shop_domain:shop::orders::Order      a type
 *   cpp:shop_domain:shop::orders::Order::addLine(const Product&,int)
 *   cpp:shop_domain:file:src/orders#shop     the free functions of a component (orders.h + orders.cpp) in a namespace
 *   cpp:lib:Qt6::Widgets                     a library the code links to
 */
export const projectId = (project) => `cpp:project:${project}`;
export const namespaceId = (project, key) => `cpp:ns:${project}/${key}`;
export const typeId = (project, qualified) => `cpp:${project}:${qualified}`;
export const holderId = (project, component, namespace) => `cpp:${project}:file:${component}#${namespace}`;
export const libraryId = (name) => `cpp:lib:${name}`;

/** A member id: its owner's id, the name and, for functions, the parameter types as declared. */
export function memberId(ownerId, name, params) {
  return params === undefined ? `${ownerId}::${name}` : `${ownerId}::${name}(${params})`;
}
