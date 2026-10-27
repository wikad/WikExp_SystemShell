//template tego gówna tsxowego


// 1. IMPORTY: biblioteki, hooki Reacta, CSS
import { useEffect, useRef } from "react";

// 2. TYP PROPSÓW: co komponent dostaje od rodzica (jak parametry funkcji)
type Props = {
  active: boolean;
};

// 3. KOMPONENT: zwykła funkcja, nazwa wielką literą, eksportowana
export function Nazwa({ active }: Props) {

  // 3a. HOOKI: stan, referencje, efekty. Zawsze na górze funkcji, nigdy w if/pętli
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // kod uruchamiany PO narysowaniu komponentu (tu: ref.current już istnieje)
    return () => {
      // cleanup: sprzątanie przy usunięciu komponentu
    };
  }, []); // [] = tylko raz, przy zamontowaniu

  // 4. JSX: co ma się pojawić na ekranie
  return <div ref={ref} />;
}