/**
 * What frameworks say about the code, from its own declarations (nothing is run):
 * - entry points: main and its platform and fuzzing variants;
 * - tests: GoogleTest, Catch2 / doctest and Boost.Test macros (extract), Qt Test classes (QTEST_MAIN);
 * - Qt: slots are handlers, Q_INVOKABLE members are called from QML (maybe used), widgets are components;
 * - Unreal Engine: functions Blueprints or the network call (UFUNCTION(BlueprintCallable…), RPCs) and game modes
 *   are entry points, UINTERFACE's I-class is an interface.
 */

const MAINS = new Set(['main', 'wmain', 'WinMain', 'wWinMain', '_tmain', '_tWinMain', 'DllMain', 'LLVMFuzzerTestOneInput', 'android_main']);
const QT_COMPONENTS = new Set(['QWidget', 'QDialog', 'QMainWindow', 'QFrame', 'QAbstractButton', 'QQuickItem', 'QQuickPaintedItem', 'QGraphicsItem', 'QGraphicsWidget', 'QGraphicsView', 'QWindow', 'QOpenGLWidget', 'QWizard', 'QWizardPage', 'QDockWidget', 'QToolBar', 'QMenu']);
const UNREAL_ENTRIES = new Set(['AGameModeBase', 'AGameMode', 'UGameInstance', 'AGameStateBase', 'AGameState', 'APlayerController', 'UGameInstanceSubsystem', 'UWorldSubsystem', 'UEngineSubsystem']);
const BLUEPRINT = /\b(BlueprintCallable|BlueprintImplementableEvent|BlueprintNativeEvent|BlueprintPure|BlueprintGetter|BlueprintSetter|BlueprintAuthorityOnly|Exec|Server|Client|NetMulticast|CallInEditor)\b/;

export class Frameworks {
  constructor(model, files) {
    this.model = model;
    this.qtestClasses = new Set(files.flatMap((f) => f.qtest ?? []));
    this.byName = new Map();
    for (const table of model.types.values()) {
      for (const entry of table.values()) {
        if (!this.byName.has(entry.name)) this.byName.set(entry.name, []);
        this.byName.get(entry.name).push(entry);
      }
    }
  }

  /** Names of every base, through the code's own classes (QWidget behind a MainWindow behind a ShopWindow). */
  baseNames(entry) {
    if (entry.baseNames) return entry.baseNames;
    entry.baseNames = new Set();
    const queue = [entry];
    const seen = new Set([entry]);
    while (queue.length) {
      const current = queue.shift();
      for (const { decl } of current.decls) {
        for (const base of decl.bases ?? []) {
          const name = simpleName(base.text);
          entry.baseNames.add(name);
          for (const next of this.byName.get(name) ?? []) if (!seen.has(next)) seen.add(next), queue.push(next);
        }
      }
    }

    return entry.baseNames;
  }

  typeKind(entry) {
    // UINTERFACE(…) class UShopper : public UInterface; class IShopper { … }: the I-class is the interface code implements.
    if (/^I[A-Z]/.test(entry.name)) {
      const marker = (this.byName.get('U' + entry.name.slice(1)) ?? []).find((u) => u.decls.some((d) => d.decl.attributes?.some((a) => a.startsWith('UINTERFACE'))));
      if (marker) return 'interface';
    }

    return null;
  }

  typeTags(entry) {
    const tags = [];
    const bases = this.baseNames(entry);
    if ([...bases].some((b) => QT_COMPONENTS.has(b))) tags.push('component');
    if ([...bases].some((b) => UNREAL_ENTRIES.has(b))) tags.push('entrypoint');
    if (this.qtestClasses.has(entry.name)) tags.push('test');
    return tags;
  }

  memberTags(member, entry) {
    const tags = [];
    const places = member.places.map((p) => p.member);
    const attributes = places.flatMap((p) => p.attributes ?? []);
    if (places.some((p) => p.section === 'slots') || attributes.includes('Q_SLOT')) tags.push(this.qtestClasses.has(entry.name) && member.places.some((p) => p.member.access === 'private') ? 'test' : 'handler');
    if (attributes.includes('Q_INVOKABLE') || attributes.includes('Q_SCRIPTABLE')) tags.push('maybe-used');
    if (attributes.some((a) => a.startsWith('UFUNCTION') && BLUEPRINT.test(a)) || /_Validate$/.test(member.name)) tags.push('entrypoint');
    return tags;
  }

  functionTags(fn) {
    const tags = [];
    if (fn.kind === 'function' && !fn.namespace && MAINS.has(fn.name)) tags.push('entrypoint');
    if (fn.places.some((p) => p.member.test)) tags.push('test');
    return tags;
  }
}

function simpleName(text) {
  const base = text.replace(/<.*$/s, '').trim();
  const parts = base.split('::');
  return parts[parts.length - 1].trim();
}
