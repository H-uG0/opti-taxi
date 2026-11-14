/** Form names of a weekday's reception hours (facility form). Pure: shared by the client form and the schema. */
export function hoursOpenField(weekday: number): string {
  return `hoursOpen${weekday}`;
}
export function hoursCloseField(weekday: number): string {
  return `hoursClose${weekday}`;
}
