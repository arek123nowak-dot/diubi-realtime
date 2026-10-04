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
7. Zaznacz dowolne slowo/fraze w lewej (oryginalnej) kolumnie napisow —
   pojawi sie przycisk **Wyjasnij**, a po kliknieciu karta z tlumaczeniem,
   znaczeniem W TYM KONKRETNYM zdaniu, przykladem i wymowa. Przycisk
   **⭐ Zapamietaj** zapisuje fraze (razem z kontekstowym zdaniem, tytulem
   strony i data) do **Moj pamietnik** — dostepnego przez ikonke 📖 w
   naglowku okienka.

## Znane ograniczenia tego prototypu

- Backend jest skonfigurowany na localhost (dwie stale do zmiany po
  publicznym wdrozeniu — patrz glowny README, sekcja "Wdrozenie publiczne"):
  `BACKEND_WS_URL` w `background.js` (`ws://localhost:3000/stream`) i
  `BACKEND_HTTP_URL` w `content.js` (`http://localhost:3000`). Dla backendu
  wdrozonego na Render/Railway (HTTPS) to musi byc `wss://` i `https://`,
  nie `ws://`/`http://` — przegladarka blokuje polaczenie z bezpiecznej
  strony (youtube.com) do niezaszyfrowanego adresu.
- Jedna aktywna sesja naslchu naraz (nowy Start na innej karcie zatrzymuje
  poprzedni).
- Overlay nie zapamietuje pozycji po przeciagnieciu miedzy sesjami.
- Dziala tylko w Chrome / przegladarkach opartych na Chromium (Edge, Brave) —
  `chrome.tabCapture`/`chrome.offscreen` to API specyficzne dla Chromium,
  nie dzialaja w Firefoksie bez osobnej wersji rozszerzenia.
