// Rozkład commitów na tory (kolumny) do narysowania grafu jak `git log --graph` / GitLens.
// Wejście: commity w kolejności topologicznej (najnowsze pierwsze), każdy z listą rodziców.

export type GraphRow = {
  col: number;                    // kolumna kropki tego commita
  top: [number, number][];        // górna połowa wiersza: linie [kolumna u góry → kolumna w środku]
  bottom: [number, number][];     // dolna połowa: linie [kolumna w środku → kolumna u dołu]
  width: number;                  // ile kolumn zajmuje ten wiersz
};

export function layoutGraph(commits: { hash: string; parents: string[] }[]): { rows: GraphRow[]; maxWidth: number } {
  let lanes: (string | null)[] = [];   // lanes[i] = hash commita, którego oczekuje tor i
  const rows: GraphRow[] = [];
  let maxWidth = 1;

  const freeSlot = (arr: (string | null)[]) => {
    const i = arr.indexOf(null);
    return i === -1 ? arr.length : i;
  };

  for (const c of commits) {
    // kolumna tego commita: tor, który na niego czeka, albo nowy (początek gałęzi)
    let col = lanes.indexOf(c.hash);
    const isTip = col === -1; // nikt na ten commit nie czekał: końcówka gałęzi, linia nie idzie w górę
    if (isTip) {
      col = freeSlot(lanes);
      lanes[col] = c.hash;
    }
    const before = [...lanes];

    // górna połowa: tory czekające na ten commit schodzą się do kropki, pozostałe idą prosto
    const top: [number, number][] = [];
    before.forEach((h, i) => {
      if (h === null || (isTip && i === col)) return;
      top.push([i, h === c.hash ? col : i]);
    });

    // tory, które też czekały na ten commit (dwie gałęzie z tym samym rodzicem), kończą się tutaj
    const after = before.map((h, i) => (h === c.hash && i !== col ? null : h));
    // pierwszy rodzic przejmuje tor commita, kolejni (merge) dostają istniejący tor albo wolny
    after[col] = c.parents[0] ?? null;
    const parentCols: number[] = c.parents.length ? [col] : [];
    for (const p of c.parents.slice(1)) {
      let j = after.indexOf(p);
      if (j === -1) {
        j = freeSlot(after);
        after[j] = p;
      }
      parentCols.push(j);
    }

    // dolna połowa: kropka → tory rodziców, pozostałe tory idą prosto
    const bottom: [number, number][] = parentCols.map((j) => [col, j]);
    after.forEach((h, i) => {
      if (h === null || i === col || parentCols.includes(i)) return;
      bottom.push([i, i]);
    });

    // przytnij puste tory z prawej
    while (after.length && after[after.length - 1] === null) after.pop();
    const width = Math.max(before.length, after.length, col + 1);
    maxWidth = Math.max(maxWidth, width);
    rows.push({ col, top, bottom, width });
    lanes = after;
  }
  return { rows, maxWidth };
}
