/**
 * Node ids. They depend only on the target, the names Swift gives (argument labels included) and the file of free
 * functions relative to its target, never on the folder that was analyzed, so the same code gets the same ids
 * whether one folder or the whole repository is mapped.
 *
 *   swift:project:Shop                          a target (SwiftPM, Xcode, Tuist, XcodeGen, podspec) or a folder
 *   swift:ns:Shop/Orders                        a folder of a target; swift:ns:Shop/ for the files at its top
 *   swift:Shop:Order                            a type; swift:Shop:Order.Line nested
 *   swift:Shop:Order.addLine(_:quantity:)       a method; swift:Shop:Order.init(id:) a constructor
 *   swift:Shop:Order.lines                      a property or field
 *   swift:Shop:extension:Orders/String          what the target adds to a type from outside, per folder
 *   swift:Shop:file:Orders/Helpers              the free functions, globals and top-level code of a file
 *   swift:pkg:swift-nio                         a package the code depends on
 */
export const projectId = (project) => `swift:project:${project}`;
export const namespaceId = (project, key) => `swift:ns:${project}/${key}`;
export const typeId = (project, qualified) => `swift:${project}:${qualified}`;
export const extensionId = (project, folder, name) => `swift:${project}:extension:${folder ? `${folder}/` : ''}${name}`;
export const holderId = (project, file) => `swift:${project}:file:${file}`;
export const packageId = (name) => `swift:pkg:${name}`;

/**
 * A member id: its owner's id and its name; for functions, initializers and subscripts the argument labels
 * (`addLine(_:quantity:)`), and the parameter types too when two overloads share the labels.
 */
export function memberId(ownerId, name, labels, types) {
  if (!labels) return `${ownerId}.${name}`;
  if (types) return `${ownerId}.${name}(${labels.map((l, i) => `${l}:${types[i] ?? ''}`).join(',')})`;
  return `${ownerId}.${name}(${labels.map((l) => `${l}:`).join('')})`;
}
