/** Something with an identity. */
export abstract class Entity {
  protected constructor(readonly id: string) {}

  equals(other: Entity) {
    return other.id === this.id;
  }
}
