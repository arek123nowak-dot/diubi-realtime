# DIUBI — rozszerzenie do przegladarki (prototyp)

Zamiast wklejac link i ladowac odtwarzacz na stronie DIUBI, to rozszerzenie
dziala na KAZDEJ karcie — klikasz ikone w pasku przegladarki, wybierasz
jezyk, i napisy na zywo pojawiaja sie w pluwajacym okienku nad strona, ktora
akurat ogladasz (YouTube, Spotify Web Player, dowolny serwis z audio).

Korzysta z tego samego backendu co wersja webowa (`server.js` w katalogu
glownym) — musi on dzialac lokalnie, dokladnie jak do tej pory.

## Wymagania

Backend musi juz dzialac (ten sam co zawsze):

```
cd ..
npm start
```

## Instalacja rozszerzenia (tryb deweloperski)

1. Otworz w Chrome: `chrome://extensions`
2. W prawym gornym rogu wlacz **"Tryb dewelopera"** ("Developer mode")
3. Kliknij **"Wczytaj rozpakowane"** ("Load unpacked")
4. Wskaz ten folder (`diubi-realtime/extension`)
5. Rozszerzenie DIUBI pojawi sie na liscie i w pasku ikon przegladarki
   (jesli nie widac ikony, kliknij ikone ukladanki/puzzle i przypnij DIUBI)

## Uzycie

1. Wejdz na strone z audio/wideo ktore chcesz tlumaczyc (np. YouTube,
   Spotify Web Player) i odtwarzaj
2. Kliknij ikone DIUBI w pasku przegladarki
3. Wybierz jezyk docelowy, kliknij **Start**
4. W prawym dolnym rogu strony pojawi sie okienko z napisami na zywo —
   mozna je przeciagac trzymajac za pasek z napisem "DIUBI"
5. **Zadnego okna wyboru karty tym razem** — rozszerzenie ma bezposredni
   dostep do dzwieku aktywnej karty (to glowna roznica wzgledem wersji
   webowej), dzwiek strony leci dalej normalnie (nie wycisza sie)
6. Klikajac X na okienku albo **Stop** w popupie — zatrzymujesz nasluch

## Znane ograniczenia tego prototypu

- Backend jest skonfigurowany na `ws://localhost:3000` (`background.js`,
  stala `BACKEND_WS_URL`) — dziala tylko gdy serwer dziala lokalnie na tym
  samym komputerze. Docelowo backend trzeba bedzie wystawic publicznie
  (np. na Render/Railway), zeby rozszerzenie dzialalo bez wlasnego serwera.
- Jedna aktywna sesja naslchu naraz (nowy Start na innej karcie zatrzymuje
  poprzedni).
- Overlay nie zapamietuje pozycji po przeciagnieciu miedzy sesjami.
- Dziala tylko w Chrome / przegladarkach opartych na Chromium (Edge, Brave) —
  `chrome.tabCapture`/`chrome.offscreen` to API specyficzne dla Chromium,
  nie dzialaja w Firefoksie bez osobnej wersji rozszerzenia.
