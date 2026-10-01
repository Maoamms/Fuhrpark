/**
 * Fuhrpark – der gesamte Serverteil in EINER Datei.
 *
 * Frueher waren es vier: Code, Dateien, Erinnerung, Einrichtung. Apps Script
 * uebersetzt ohnehin alle .gs gemeinsam, die Aufteilung war also reine
 * Ordnung - und jede Datei ein weiterer Handgriff beim Uebertragen in den
 * Editor, bei dem etwas verrutschen kann. Genau daran ist eine ganze Nacht
 * gescheitert. Also: eine Datei, ein Einfuegen.
 *
 * Diese Datei ist die Quelle: Sie wird so, wie sie ist, in den
 * Skripteditor uebertragen.
 */

/* ================= Code ================= */

/**
 * Fuhrpark – Serverteil (Google Apps Script)
 *
 * Alle Daten liegen in einer Google-Tabelle, alle Belege in einem Drive-Ordner.
 * Beide gehoeren dem Eigentuemer des Skripts; die Web-App laeuft mit dessen
 * Rechten ("Ausfuehren als: Ich"), damit Nutzer kein Google-Konto brauchen.
 *
 * Weil Google in dieser Betriebsart die Identitaet des Besuchers verbirgt,
 * bringt die App eine eigene Anmeldung mit: Profil waehlen, Passwort eingeben.
 * Entscheidend ist, dass JEDER Aufruf das Sitzungstoken mitschickt und der
 * Server daraus das Profil ermittelt – der Browser darf nie bestimmen, wessen
 * Daten er bekommt.
 */

// ---------------------------------------------------------------- Konstanten

/**
 * Die Feldnamen sind dieselben wie in der bisherigen App. Das ist Absicht:
 * Die Ansichten werden unveraendert uebernommen, sie tragen die Gestaltung.
 * Eine Umbenennung haette eine Uebersetzungsschicht noetig gemacht – eine
 * Fehlerquelle ohne jeden Gegenwert.
 */
var TABELLEN = {
  profile:   ['id', 'name', 'farbe', 'email', 'salt', 'hash', 'rolle', 'angelegt',
              // runden: wie oft gehasht wird. hashArt: nach welcher Rechenweise -
              // "hex" ist die alte, "bytes" die heutige. Ohne diese Angabe
              // waeren nach einer Umstellung alle Passwoerter ungueltig.
              'runden', 'hashArt'],

  // art: auto | anhaenger | wohnmobil | motorrad. Entscheidet, welche
  // Wartungsvorlagen passen und welches Zeichen das Fahrzeug traegt.
  vehicles:  ['id', 'profilId', 'name', 'art', 'plate', 'model', 'vin', 'firstReg',
              'km', 'kmDate',
              // Zulassungsbescheinigung und Technik
              'hsn', 'tsn', 'engineCode', 'fuelType', 'gearbox', 'powerKw',
              'displacement', 'emissionClass', 'seats', 'consumption',
              'weightEmpty', 'weightMax', 'trailerLoad',
              // Anhaenger und Wohnmobil
              'noseWeight', 'tempo100', 'brakeType', 'bodyType', 'firstAidExpiry',
              // Teile und Verbrauchsmaterial – zum Bestellen und Nachschlagen
              'color', 'colorCode', 'tyreSize', 'pressureFront', 'pressureRear',
              'wheelBolts', 'wiperFront', 'wiperRear', 'lampLow', 'lampHigh',
              'battery', 'oilType', 'oilAmount', 'coolant',
              // Versicherung, Notfall, Kauf
              'insurance', 'insuranceNo', 'claimPhone', 'breakdownPhone', 'garage',
              'purchaseDate', 'purchasePrice', 'dealer', 'note', 'updatedAt'],

  // dueDate: fest eingetragener Termin, geht vor der Rechnung aus lastDate.
  // leadDays: eigene Vorwarnzeit; leer bedeutet die Vorgabe von 30 Tagen.
  intervals: ['id', 'vehicleId', 'kind', 'intervalKm', 'intervalMonths',
              'lastDate', 'lastKm', 'dueDate', 'leadDays',
              'note', 'reported', 'updatedAt'],
  events:    ['id', 'vehicleId', 'date', 'type', 'desc', 'km', 'shop', 'cost',
              'note', 'docId', 'updatedAt'],
  // kiStatus: '' (nie angefordert) | ausstehend | fertig | fehlgeschlagen.
  // Die Auswertung ist ein eigener Schritt NACH dem Speichern - scheitert
  // sie, bleibt der Beleg trotzdem liegen und laesst sich spaeter erneut
  // auslesen. blatt_() haengt die neuen Spalten hinten an.
  docs:      ['id', 'vehicleId', 'category', 'title', 'date', 'name', 'mime',
              'size', 'driveId', 'updatedAt', 'kiStatus', 'kiFehler', 'kiVersuche'],
  fixcosts:  ['id', 'vehicleId', 'kind', 'amount', 'interval', 'date', 'note', 'updatedAt'],
  // docId: eine Notiz darf einen Beleg tragen – Foto vom Schaden, Angebot,
  // Schriftwechsel. blatt_() haengt die Spalte bei Bedarf hinten an.
  notes:     ['id', 'vehicleId', 'date', 'text', 'docId', 'updatedAt'],

  // Neu hinzugekommen
  kmlog:     ['id', 'vehicleId', 'date', 'km', 'note', 'updatedAt'],
  deadlines: ['id', 'vehicleId', 'kind', 'date', 'leadDays', 'note', 'reported', 'updatedAt'],

  // Ein Satz Reifen, nicht ein einzelner Reifen: gewechselt, gelagert und
  // gekauft wird satzweise. dot ist das Herstellungsdatum als Woche/Jahr,
  // montiert sagt, welcher Satz gerade am Fahrzeug ist.
  tyres:     ['id', 'vehicleId', 'season', 'brand', 'productName', 'size', 'dot',
              'treadMm', 'storage', 'montiert', 'mountedSince', 'boughtDate',
              'note', 'updatedAt'],

  // Werkstaetten als eigener Bestand, damit man Anschrift und Erfahrungen
  // einmal hinterlegt statt in jedem Eintrag neu.
  shops:     ['id', 'profilId', 'name', 'ort', 'phone', 'note', 'updatedAt']
};

/** Bestaende, die an einem Fahrzeug haengen – ueber sie laeuft die Zugriffspruefung. */
var AM_FAHRZEUG = ['intervals', 'events', 'docs', 'fixcosts', 'notes',
                   'kmlog', 'deadlines', 'tyres'];

var SITZUNG_STUNDEN = 12;

/*
 * Wer was aufrufen darf.
 *
 * google.script.run kann aus dem Browser JEDE Funktion dieses Projekts
 * aufrufen - ausgenommen nur die, deren Name auf "_" endet. Alles, was nur
 * der Server selbst braucht, traegt deshalb diesen Unterstrich. Frueher
 * fehlte er, und jeder mit dem Link konnte etwa lies('profile') oder
 * setzePasswort(...) direkt aufrufen - ganz ohne Anmeldung.
 *
 * Die Verwaltungsfunktionen weiter unten sollen im Skripteditor in der
 * Auswahlliste stehen bleiben, duerfen also keinen Unterstrich bekommen.
 * Sie pruefen stattdessen mit nurImEditor_(), dass der Eigentuemer selbst
 * sie ausfuehrt. Ein Besucher der Web-App ist fuer Apps Script anonym
 * (leere Adresse) - das genuegt als Unterscheidung.
 */
function nurImEditor_() {
  var aktiv = '', eigner = '';
  try { aktiv = Session.getActiveUser().getEmail(); } catch (e) {}
  try { eigner = Session.getEffectiveUser().getEmail(); } catch (e) {}
  if (!aktiv || aktiv !== eigner) {
    throw new Error('Diese Funktion laeuft nur im Skripteditor.');
  }
}

// ------------------------------------------------------------- Einstiegspunkt

function doGet() {
  // Das Geruest der Seite steht hier, nicht in einer Vorlagendatei.
  //
  // Frueher lag es in index.html mit zwei Vorlagenbefehlen darin. Ging
  // beim Uebertragen dieser Datei etwas schief, erschienen die Befehle
  // als Text auf der Seite und nichts lief - ohne erkennbaren Grund.
  // Jetzt muessen nur noch zwei Dateien stimmen: styles und app.
  var seite = [
    '<!DOCTYPE html>',
    '<html lang="de">',
    '<head>',
    '<base target="_top">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>Fuhrpark</title>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">'
  ].join('\n') + '\n'
    + einbinden_('styles') + '\n'
    + [
      '</head>',
      '<body>',
      '<div class="app">',
      '  <aside class="side">',
      '    <div class="side-top">',
      '      <div class="brand"><span class="mark">FP</span><span class="brand-name">Fuhrpark</span></div>',
      '      <!-- Fahrzeugwahl als Kennzeichen. Das Menue wird selbst gezeichnet:',
      '           ein <select> stellt das Betriebssystem dar, es liesse sich also',
      '           nicht in die Gestaltung der App einfuegen. -->',
      '      <div class="plate-wahl" id="vehPicker"></div>',
      '    </div>',
      '    <nav id="nav"></nav>',
      '    <div class="side-foot">',
      '      <div id="profilBox" class="storagebox profilbox"></div>',
      '    </div>',
      '  </aside>',
      '  <!-- Suchfeld und die beiden Knoepfe stehen ueber jeder Ansicht, nicht mehr',
      '       unten in der Seitenleiste: dort sind sie auf dem Weg zum Inhalt. -->',
      '  <main>',
      '    <header class="kopfleiste" id="kopfleiste"></header>',
      '    <div id="main"></div>',
      '  </main>',
      '</div>',
      '',
      '<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>',
      '<div class="toast" id="toast"></div>',
      '',
      '<!-- Selbstdiagnose.',
      '     Laeuft der Code darunter nicht an, sah man bisher nur dieses Geruest:',
      '     Seitenleiste, sonst nichts, keine Meldung. Diese beiden kleinen Skripte',
      '     fangen den Fehler ab und schreiben ihn sichtbar auf die Seite - samt',
      '     Stand der geladenen Fassung, damit erkennbar ist, ob eine neue',
      '     Bereitstellung ueberhaupt angekommen ist. -->',
      '<!-- Dieser Block steht bewusst VOR dem Programmteil, nicht dahinter.',
      '     Wird "app" unvollstaendig eingefuegt, bleibt dessen <script> offen und',
      '     verschluckt alles, was danach im Dokument steht - eine Diagnose dahinter',
      '     wuerde nie laufen. Davor laeuft sie immer, und ihr Zeitgeber ebenso. -->',
      '<script>',
      'window.__fpFehler = null;',
      'window.addEventListener(\'error\', function (e) {',
      '  if (!window.__fpFehler) {',
      '    window.__fpFehler = (e.message || \'Fehler\') +',
      '      (e.filename ? \'  (\' + String(e.filename).split(\'/\').pop() + \':\' + e.lineno + \')\' : \'\');',
      '  }',
      '});',
      'setTimeout(function () {',
      '  if (window.__fpGestartet) return;',
      '  var grund = window.__fpFehler ||',
      '    \'Der Programmteil wurde nicht ausgefuehrt. Meist ist die Datei "app" im \' +',
      '    \'Skripteditor unvollstaendig eingefuegt, oder es wurde nach dem Einfuegen \' +',
      '    \'keine neue Version bereitgestellt.\';',
      '  var k = document.createElement(\'div\');',
      '  k.setAttribute(\'style\', \'position:fixed;inset:0;z-index:9999;overflow:auto;\' +',
      '    \'background:#F4F1EA;color:#2C2A26;font:15px/1.6 system-ui,sans-serif;padding:32px\');',
      '  k.innerHTML =',
      '    \'<div style="max-width:620px;margin:0 auto">\' +',
      '    \'<h2 style="margin:0 0 6px">Die App ist nicht gestartet</h2>\' +',
      '    \'<p style="color:#6B6559;margin:0 0 18px">Das Geruest wurde geladen, der \' +',
      '    \'Programmteil nicht.</p>\' +',
      '    \'<pre style="white-space:pre-wrap;word-break:break-word;background:#FFF;\' +',
      '    \'border:1px solid #DDD6C8;border-radius:10px;padding:14px;font-size:13px">\' +',
      '    String(grund).replace(/[<&]/g, function (c) { return c === \'<\' ? \'&lt;\' : \'&amp;\'; }) +',
      '    \'</pre>\' +',
      '    \'<p style="color:#6B6559;font-size:13.5px">Zum Pruefen im Skripteditor: Datei \' +',
      '    \'<b>app</b> oeffnen, mit Strg+Ende ans Ende springen. Dort muss \' +',
      '    \'<code>&lt;/script&gt;</code> stehen. Danach speichern und unter \' +',
      '    \'<b>Bereitstellen &rarr; Bereitstellungen verwalten</b> eine <b>neue Version</b> \' +',
      '    \'bereitstellen.</p>\' +',
      '    \'<p style="color:#8B8478;font-size:12.5px">Stand der geladenen Fassung: \' +',
      '    (window.__fpStand || \'unbekannt - die Datei "app" ist nicht angekommen\') + \'</p>\' +',
      '    \'</div>\';',
      '  document.body.appendChild(k);',
      '}, 4000);',
      '</script>'
      ].join('\n') + '\n'
    + einbinden_('app') + '\n'
    + [
      '</body>',
      '</html>'
      ].join('\n');

  return HtmlService.createHtmlOutput(seite)
    .setTitle('Fuhrpark')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Bindet Teildateien in index.html ein: <?!= einbinden_('styles') ?> */
function einbinden_(datei) {
  return HtmlService.createHtmlOutputFromFile(datei).getContent();
}

// ------------------------------------------------------------- Ablage: Basis

function eigenschaften_() {
  return PropertiesService.getScriptProperties();
}

function zeitzone_() {
  try { return Session.getScriptTimeZone() || 'Europe/Berlin'; }
  catch (e) { return 'Europe/Berlin'; }
}

/**
 * Liefert die Tabelle und legt sie beim ersten Aufruf an. Die Kennung wird
 * gespeichert, damit nicht bei jedem Aufruf gesucht werden muss und damit
 * keine zweite Tabelle entsteht.
 */
/*
 * Zwischenspeicher fuer die Dauer EINER Ausfuehrung.
 *
 * Jeder Zugriff auf Sheets ist ein Netzaufruf von Googles Servern zu Googles
 * Servern und kostet ein Zehntel bis eine halbe Sekunde. holeAlles() liest
 * elf Bestaende; ohne Zwischenspeicher wurde dafuer elfmal die Mappe
 * geoeffnet, elfmal die Kopfzeile geholt und elfmal nachgesehen, ob Spalten
 * fehlen. Das war der Grund fuer die lange Wartezeit beim Start.
 *
 * Die Speicher leben nur innerhalb eines Aufrufs - Apps Script startet fuer
 * jeden Aufruf eine frische Umgebung. Es kann also nichts veralten.
 */
var _mappe = null;
var _blaetter = {};
var _zeilen = {};
var _geprueft = {};

/** Nach dem Schreiben muss der Bestand neu gelesen werden. */
function vergiss_(name) {
  if (name) delete _zeilen[name];
  else _zeilen = {};
}

function mappe_() {
  if (_mappe) return _mappe;
  var props = eigenschaften_();
  var id = props.getProperty('TABELLE_ID');
  if (id) {
    try { _mappe = SpreadsheetApp.openById(id); return _mappe; }
    catch (e) { /* neu anlegen */ }
  }
  var sperre = LockService.getScriptLock();
  sperre.waitLock(30000);
  try {
    id = props.getProperty('TABELLE_ID');
    if (id) { try { _mappe = SpreadsheetApp.openById(id); return _mappe; } catch (e) {} }
    var neu = SpreadsheetApp.create('Fuhrpark – Daten');
    props.setProperty('TABELLE_ID', neu.getId());
    _mappe = neu;
    return neu;
  } finally {
    sperre.releaseLock();
  }
}

/** Liefert ein Blatt mit garantierter Kopfzeile. */
function blatt_(name) {
  if (_blaetter[name]) return _blaetter[name];
  var ss = mappe_();
  var b = ss.getSheetByName(name);
  var spalten = TABELLEN[name];
  if (!spalten) throw new Error('Unbekannter Datenbestand: ' + name);
  if (!b) {
    b = ss.insertSheet(name);
    b.getRange(1, 1, 1, spalten.length).setValues([spalten]);
    b.setFrozenRows(1);
    var leer = ss.getSheetByName('Tabellenblatt1') || ss.getSheetByName('Sheet1');
    if (leer && ss.getSheets().length > 1) ss.deleteSheet(leer);
    _blaetter[name] = b;
    return b;
  }

  if (_geprueft[name]) { _blaetter[name] = b; return b; }
  _geprueft[name] = true;

  // Kommt eine Spalte im Code dazu, fehlt sie in der bestehenden Tabelle.
  // Sie wird hinten angehaengt – niemals eingefuegt: Die vorhandenen Zeilen
  // stehen in der Reihenfolge der alten Kopfzeile, und ein Einschub wuerde
  // jede Angabe rechts davon um eine Spalte verschieben.
  var kopf = kopfVon_(b);
  var fehlend = [];
  for (var i = 0; i < spalten.length; i++) {
    if (kopf.indexOf(spalten[i]) === -1) fehlend.push(spalten[i]);
  }
  if (fehlend.length) {
    b.getRange(1, kopf.length + 1, 1, fehlend.length).setValues([fehlend]);
  }
  _blaetter[name] = b;
  return b;
}

/** Die Kopfzeile eines Blattes – sie bestimmt, wo welcher Wert steht. */
function kopfVon_(b) {
  var breite = b.getLastColumn();
  if (!breite) return [];
  return b.getRange(1, 1, 1, breite).getValues()[0].map(function (w) {
    return String(w || '').trim();
  });
}

function belegOrdner_() {
  var props = eigenschaften_();
  var id = props.getProperty('ORDNER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* neu anlegen */ }
  }
  var sperre = LockService.getScriptLock();
  sperre.waitLock(30000);
  try {
    id = props.getProperty('ORDNER_ID');
    if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
    var neu = DriveApp.createFolder('Fuhrpark – Belege');
    props.setProperty('ORDNER_ID', neu.getId());
    return neu;
  } finally {
    sperre.releaseLock();
  }
}

// --------------------------------------------------------- Ablage: Lesen

/**
 * Wandelt ein Blatt in Objekte. Leere Zeilen werden uebersprungen; das kommt
 * vor, wenn jemand direkt in der Tabelle Zeilen loescht.
 */
function lies_(name) {
  if (_zeilen[name]) return _zeilen[name];

  // Die Kopfzeile steckt in den gelesenen Daten - sie noch einmal einzeln zu
  // holen waeren zwei weitere Netzaufrufe je Bestand. Bei elf Bestaenden
  // waren das allein beim Start zweiundzwanzig ueberfluessige Wege.
  var ss = mappe_();
  var b = _blaetter[name] || ss.getSheetByName(name);
  if (!b) b = blatt_(name);
  _blaetter[name] = b;

  var werte = b.getDataRange().getValues();
  var kopf = (werte[0] || []).map(String);

  // Fehlende Spalten einmal je Ausfuehrung anhaengen - ohne zusaetzliches
  // Lesen, die Kopfzeile liegt ja vor.
  if (!_geprueft[name]) {
    _geprueft[name] = true;
    var soll = TABELLEN[name] || [];
    var fehlend = [];
    for (var f = 0; f < soll.length; f++) {
      if (kopf.indexOf(soll[f]) === -1) fehlend.push(soll[f]);
    }
    if (fehlend.length && kopf.length) {
      b.getRange(1, kopf.length + 1, 1, fehlend.length).setValues([fehlend]);
      kopf = kopf.concat(fehlend);
    }
  }

  if (werte.length < 2) { _zeilen[name] = []; return _zeilen[name]; }
  var raus = [];
  for (var i = 1; i < werte.length; i++) {
    if (!werte[i][0]) continue;
    var o = {};
    // Wurde gerade eine Spalte angehaengt, sind die vorhandenen Zeilen noch
    // kuerzer als die Kopfzeile. Dann ist das Feld leer, nicht undefiniert.
    for (var s = 0; s < kopf.length; s++) {
      var w = werte[i][s];
      o[kopf[s]] = entpacke_(w === undefined ? '' : w);
    }
    raus.push(o);
  }
  _zeilen[name] = raus;
  return raus;
}

/**
 * Sheets liefert Datumswerte als Date und Zahlen als Number. Fuer den Browser
 * wird ein Datum zu "JJJJ-MM-TT".
 *
 * Umgerechnet wird in der Zeitzone des Skripts, nicht in UTC: Sheets legt ein
 * Datum als Mitternacht Ortszeit ab, in Deutschland also 22 oder 23 Uhr UTC am
 * Vortag. Mit UTC wuerde aus dem 1. November der 31. Oktober – jedes Datum
 * waere einen Tag zu frueh.
 */
function entpacke_(wert) {
  if (wert === '' || wert === null || wert === undefined) return '';
  if (Object.prototype.toString.call(wert) === '[object Date]') {
    return Utilities.formatDate(wert, zeitzone_(), 'yyyy-MM-dd');
  }
  return wert;
}

/**
 * Schuetzt die Tabelle davor, Nutzereingaben als Formel auszuwerten. Ein Wert
 * wie "=WENN(...)" oder "+49 170" wuerde sonst in Sheets zur Formel.
 */
function entschaerfe_(wert) {
  if (typeof wert !== 'string') return wert;
  if (/^[=+\-@]/.test(wert)) return "'" + wert;
  return wert;
}

// --------------------------------------------------------- Ablage: Schreiben

function neueId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

/**
 * Legt an oder aktualisiert – erkannt an der id. Gibt den geschriebenen
 * Datensatz zurueck, damit der Browser die vergebene Kennung kennt.
 */
function schreibe_(name, datensatz) {
  var sperre = LockService.getScriptLock();
  sperre.waitLock(30000);
  try {
    var b = blatt_(name);
    if (!datensatz.id) datensatz.id = neueId_();
    datensatz.updatedAt = new Date().toISOString();

    // Geschrieben wird nach der Kopfzeile der Tabelle, nicht nach der
    // Reihenfolge im Code. Sonst landet ein spaeter eingefuegtes Feld unter
    // der falschen Ueberschrift und ueberschreibt eine bestehende Angabe.
    var kopf = kopfVon_(b);
    var zeile = kopf.map(function (s) {
      var w = datensatz[s];
      return entschaerfe_(w === undefined || w === null ? '' : w);
    });

    var ids = b.getRange(1, 1, Math.max(b.getLastRow(), 1), 1).getValues();
    for (var i = 1; i < ids.length; i++) {
      if (ids[i][0] === datensatz.id) {
        b.getRange(i + 1, 1, 1, kopf.length).setValues([zeile]);
        vergiss_(name);
        return datensatz;
      }
    }
    b.appendRow(zeile);
    vergiss_(name);
    return datensatz;
  } finally {
    sperre.releaseLock();
  }
}

function entferne_(name, id) {
  var sperre = LockService.getScriptLock();
  sperre.waitLock(30000);
  try {
    var b = blatt_(name);
    var ids = b.getRange(1, 1, Math.max(b.getLastRow(), 1), 1).getValues();
    for (var i = 1; i < ids.length; i++) {
      if (ids[i][0] === id) { b.deleteRow(i + 1); vergiss_(name); return true; }
    }
    return false;
  } finally {
    sperre.releaseLock();
  }
}

// ------------------------------------------------------------- Anmeldung

/*
 * Wie oft das Passwort durch die Hashfunktion geht.
 *
 * Einmal SHA-256 ist blitzschnell - auch fuer jemanden, der die Tabelle in
 * die Haende bekommt und Millionen Woerter durchprobiert. Viele Runden
 * machen jeden einzelnen Versuch teuer, ohne dass die Anmeldung spuerbar
 * langsamer wird: einmal rechnen dauert Bruchteile einer Sekunde.
 */
/*
 * 60.000 Runden waren ein Fehlgriff.
 *
 * Auf einem gewoehnlichen Rechner sind so viele SHA-256-Durchlaeufe eine
 * Sache von Millisekunden. In Apps Script ist jeder Aufruf von
 * Utilities.computeDigest ein Uebergang von JavaScript nach Java und kostet
 * rund eine Millisekunde - 60.000 davon sind also eine Minute. Genau so
 * lange dauerte das Anmelden.
 *
 * Ein paar Hundert Runden machen das Durchprobieren gestohlener Hashwerte
 * immer noch hundertfach teurer als ein einzelner Durchlauf, ohne dass
 * jemand wartet. Mit misstHash() laesst sich der Wert nachmessen und
 * anpassen.
 */
var HASH_RUNDEN = 400;

function alsHex_(bytes) {
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

/**
 * Hashwert eines Passworts.
 *
 * runden === 1 ist die alte Rechenweise. Sie bleibt gueltig, damit sich
 * vorhandene Profile weiter anmelden koennen; beim naechsten erfolgreichen
 * Anmelden wird der Eintrag still auf die neue Rundenzahl gehoben.
 */
function hashe_(passwort, salt, runden) {
  var n = runden ? Number(runden) : 1;

  // Die erste Runde geht ueber den Text, alle weiteren ueber die Bytes.
  var wert = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + '|' + passwort, Utilities.Charset.UTF_8);
  for (var i = 1; i < n; i++) {
    wert = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, wert);
  }
  return alsHex_(wert);
}

/**
 * Die alte Rechenweise: nach jeder Runde in Hex wandeln.
 *
 * Sie bleibt, weil bereits gespeicherte Hashwerte so entstanden sind. Wer
 * die Rechenweise aendert, ohne die alte zu behalten, sperrt jeden aus -
 * genau das ist hier passiert: Das Anmelden rechnete sechzigtausend Runden
 * und meldete am Ende "Passwort stimmt nicht".
 *
 * Bei einer einzigen Runde sind beide Wege identisch; unterschiedlich wird
 * es erst ab der zweiten.
 */
function hasheHex_(passwort, salt, runden) {
  var n = runden ? Number(runden) : 1;
  var wert = salt + '|' + passwort;
  for (var i = 0; i < n; i++) {
    wert = alsHex_(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, wert, Utilities.Charset.UTF_8));
  }
  return wert;
}

/** Welche Rechenweise zu einem Profil gehoert. */
function hashArtVon_(profil) {
  if (profil && profil.hashArt) return profil.hashArt;
  // Ohne Angabe: alles mit mehr als einer Runde stammt aus der alten Zeit.
  return (profil && Number(profil.runden) > 1) ? 'hex' : 'bytes';
}

/**
 * Misst, was die Rundenzahl auf diesem Server wirklich kostet.
 *
 * Im Skripteditor ausfuehren. Anmelden soll spuerbar sofort passieren -
 * alles unter etwa einer halben Sekunde ist in Ordnung.
 */
function misstHash() {
  nurImEditor_();
  [100, 400, 1000, 4000].forEach(function (n) {
    var t = Date.now();
    hashe_('probewort', 'probesalz', n);
    console.log(n + ' Runden: ' + (Date.now() - t) + ' ms');
  });
  console.log('Eingestellt sind ' + HASH_RUNDEN + ' Runden.');
  console.log('Zum Aendern: HASH_RUNDEN oben in dieser Datei, danach fuer jedes '
            + 'Profil einmal setzePasswort(...) aufrufen.');
}

/**
 * Vergleich in konstanter Zeit. Bei einem frueh abbrechenden Vergleich liesse
 * sich aus der Antwortzeit ableiten, wie viele Zeichen stimmen.
 */
function gleichSicher_(a, b) {
  if (a.length !== b.length) return false;
  var unterschied = 0;
  for (var i = 0; i < a.length; i++) unterschied |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return unterschied === 0;
}

/**
 * Oeffentlich: die Liste der Profile, noch ohne Anmeldung. Enthaelt bewusst
 * nur Anzeigename und Farbe – niemals Salt oder Hashwert.
 */
function profilListe() {
  return lies_('profile').map(function (p) {
    return { id: p.id, name: p.name, farbe: p.farbe };
  });
}

/*
 * Fehlversuche je Profil. Ohne Begrenzung kann jeder, der den Link hat,
 * unbegrenzt Passwoerter durchprobieren - eine kurze Verzoegerung je Versuch
 * haelt das nicht auf. Der Zaehler steht im Cache und laeuft von selbst ab.
 */
var SPERRE_AB = 8;
var SPERRE_MINUTEN = 15;

function fehlversuche_(profilId) {
  var roh = CacheService.getScriptCache().get('fehl_' + profilId);
  return roh ? Number(roh) : 0;
}

function merkeFehlversuch_(profilId) {
  var n = fehlversuche_(profilId) + 1;
  CacheService.getScriptCache().put('fehl_' + profilId, String(n), SPERRE_MINUTEN * 60);
  return n;
}

function anmelden(daten) {
  var profile = lies_('profile');
  var p = null;
  for (var i = 0; i < profile.length; i++) {
    if (profile[i].id === daten.profilId) { p = profile[i]; break; }
  }

  var kennung = p ? p.id : 'unbekannt';
  if (fehlversuche_(kennung) >= SPERRE_AB) {
    throw new Error('Zu viele Fehlversuche. Bitte ' + SPERRE_MINUTEN + ' Minuten warten.');
  }

  // Auch bei unbekanntem Profil wird gehasht, damit die Antwortzeit nichts
  // darueber verraet, ob es das Profil ueberhaupt gibt.
  var runden = p && p.runden ? Number(p.runden) : 1;
  var art = hashArtVon_(p);
  var pruef = (art === 'hex')
    ? hasheHex_(String(daten.passwort || ''), p ? p.salt : 'x', runden)
    : hashe_(String(daten.passwort || ''), p ? p.salt : 'x', runden);
  if (!p || !gleichSicher_(pruef, String(p.hash))) {
    var versuche = merkeFehlversuch_(kennung);
    Utilities.sleep(700);
    throw new Error(versuche >= SPERRE_AB
      ? 'Zu viele Fehlversuche. Bitte ' + SPERRE_MINUTEN + ' Minuten warten.'
      : 'Passwort stimmt nicht.');
  }
  CacheService.getScriptCache().remove('fehl_' + kennung);

  // Noch nach der alten Rechenweise oder mit anderer Rundenzahl abgelegt?
  // Dann jetzt umstellen - das Passwort liegt nur in diesem Augenblick im
  // Klartext vor. Danach ist die Anmeldung wieder schnell.
  if (runden !== HASH_RUNDEN || art !== 'bytes') {
    p.runden = HASH_RUNDEN;
    p.hashArt = 'bytes';
    p.hash = hashe_(String(daten.passwort || ''), p.salt, HASH_RUNDEN);
    schreibe_('profile', p);
  }
  var token = Utilities.getUuid() + Utilities.getUuid();
  var sitzung = JSON.stringify({ profilId: p.id, ablauf: Date.now() + SITZUNG_STUNDEN * 3600 * 1000 });
  CacheService.getScriptCache().put('sitzung_' + token, sitzung, 21600);
  eigenschaften_().setProperty('sitzung_' + token, sitzung);
  return { token: token, profil: { id: p.id, name: p.name, farbe: p.farbe, rolle: p.rolle } };
}

/**
 * Holt den Sitzungsschluessel aus dem, was der Browser geschickt hat.
 *
 * google.script.run reicht genau ein Argument durch. Die meisten Funktionen
 * bekommen ein Objekt { …, token }, abmelden() nur den Schluessel selbst.
 * Beides wird hier auseinandergehalten – sonst landet "[object Object]" in
 * der Sitzungssuche und alles meldet "Nicht angemeldet", obwohl die
 * Anmeldung gerade erfolgreich war.
 */
function tokenAus_(daten) {
  if (!daten) return null;
  return (typeof daten === 'object') ? daten.token : daten;
}

/**
 * Herzstueck der Trennung: Aus dem Token wird das Profil ermittelt. Jede
 * Datenfunktion ruft das zuerst auf. Faellt es aus, passiert gar nichts.
 */
function profilAusToken_(token) {
  token = tokenAus_(token);
  if (!token) throw new Error('Nicht angemeldet.');
  var roh = CacheService.getScriptCache().get('sitzung_' + token);
  if (!roh) roh = eigenschaften_().getProperty('sitzung_' + token);
  if (!roh) throw new Error('Nicht angemeldet.');
  var s = JSON.parse(roh);
  if (s.ablauf < Date.now()) {
    eigenschaften_().deleteProperty('sitzung_' + token);
    throw new Error('Anmeldung abgelaufen.');
  }
  var profile = lies_('profile');
  for (var i = 0; i < profile.length; i++) {
    if (profile[i].id === s.profilId) {
      return { id: profile[i].id, name: profile[i].name,
               farbe: profile[i].farbe, rolle: profile[i].rolle };
    }
  }
  throw new Error('Profil gibt es nicht mehr.');
}

function abmelden(token) {
  if (!token) return true;
  CacheService.getScriptCache().remove('sitzung_' + token);
  eigenschaften_().deleteProperty('sitzung_' + token);
  return true;
}

/**
 * Entfernt abgelaufene Sitzungen. Ohne das wuechse der Eigenschaftsspeicher
 * mit jeder Anmeldung, die nie wieder benutzt wird – und er ist begrenzt.
 */
function raeumeSitzungenAuf_() {
  var props = eigenschaften_();
  var alle = props.getProperties();
  var jetzt = Date.now();
  var weg = 0;
  Object.keys(alle).forEach(function (k) {
    if (k.indexOf('sitzung_') !== 0) return;
    try {
      if (JSON.parse(alle[k]).ablauf < jetzt) { props.deleteProperty(k); weg++; }
    } catch (e) {
      props.deleteProperty(k); weg++;
    }
  });
  return weg;
}

// ------------------------------------------------------------- Daten holen

/**
 * Liefert den gesamten Bestand des angemeldeten Profils in einem Rutsch.
 * Danach arbeitet der Browser aus dem Speicher – deshalb ist nur der erste
 * Aufruf langsam.
 *
 * Ein Verwalter sieht alle Fahrzeuge. Das ist eine Einstellung in der Tabelle
 * und laesst sich vom Browser aus nicht setzen.
 */
function holeAlles(daten) {
  var profil = profilAusToken_(tokenAus_(daten));
  var alle = lies_('vehicles');
  var meine = profil.rolle === 'verwalter' ? alle
    : alle.filter(function (f) { return f.profilId === profil.id; });
  var erlaubt = {};
  meine.forEach(function (f) { erlaubt[f.id] = true; });

  var daten = { profil: profil, vehicles: meine };
  AM_FAHRZEUG.forEach(function (name) {
    daten[name] = lies_(name).filter(function (z) { return erlaubt[z.vehicleId]; });
  });

  // Werkstaetten haengen am Profil, nicht am Fahrzeug – dieselbe Werkstatt
  // macht den Jumper und den Anhaenger.
  daten.shops = lies_('shops').filter(function (w) {
    return profil.rolle === 'verwalter' || w.profilId === profil.id;
  });

  daten.stand = new Date().toISOString();
  return daten;
}

// ------------------------------------------------------------ Daten schreiben

/** Prueft, ob ein Fahrzeug dem angemeldeten Profil gehoert. */
function gehoertMir_(profil, vehicleId) {
  if (!vehicleId) return false;
  var alle = lies_('vehicles');
  for (var i = 0; i < alle.length; i++) {
    if (alle[i].id === vehicleId) {
      return profil.rolle === 'verwalter' || alle[i].profilId === profil.id;
    }
  }
  return false;
}

function speichere(daten) {
  var profil = profilAusToken_(daten.token);
  var name = daten.bestand;
  var satz = daten.datensatz || {};
  if (!TABELLEN[name]) throw new Error('Unbekannter Datenbestand.');
  if (name === 'profile') throw new Error('Profile werden hier nicht geaendert.');

  if (name === 'vehicles') {
    // Der Besitzer wird immer serverseitig gesetzt. Schickt der Browser eine
    // fremde profilId mit, wird sie ueberschrieben.
    //
    // Entscheidend ist, ob es das Fahrzeug schon GIBT - nicht, ob eine
    // Kennung mitkommt. Die vergibt naemlich schon der Browser, auch beim
    // Anlegen. Wer hier auf die blosse Kennung geprueft hat, hat jedes neue
    // Fahrzeug abgelehnt: Die Suche danach ging ins Leere, und das sah aus
    // wie ein fremdes Fahrzeug.
    var vorhanden = satz.id
      ? lies_('vehicles').filter(function (f) { return f.id === satz.id; })[0]
      : null;
    if (vorhanden) {
      if (profil.rolle !== 'verwalter' && vorhanden.profilId !== profil.id) {
        throw new Error('Kein Zugriff auf dieses Fahrzeug.');
      }
      satz.profilId = vorhanden.profilId;
    } else {
      satz.profilId = profil.id;
    }
  } else if (name === 'shops') {
    // Werkstaetten gehoeren dem Profil. Wie beim Fahrzeug wird der Besitzer
    // serverseitig gesetzt, damit der Browser ihn nicht faelschen kann.
    if (satz.id) {
      var alteW = lies_('shops').filter(function (w) { return w.id === satz.id; })[0];
      if (alteW && profil.rolle !== 'verwalter' && alteW.profilId !== profil.id) {
        throw new Error('Kein Zugriff auf diese Werkstatt.');
      }
      satz.profilId = alteW ? alteW.profilId : profil.id;
    } else {
      satz.profilId = profil.id;
    }
  } else {
    if (!gehoertMir_(profil, satz.vehicleId)) throw new Error('Kein Zugriff auf dieses Fahrzeug.');

    // Geprueft werden muss auch der Satz, der UNTER DIESER KENNUNG schon
    // steht. schreibe_() ersetzt nach der id - ohne diese Pruefung liesse
    // sich ein fremder Eintrag ueberschreiben, indem man das eigene
    // Fahrzeug mitschickt.
    var alt = satz.id
      ? lies_(name).filter(function (z) { return z.id === satz.id; })[0]
      : null;
    if (alt && !gehoertMir_(profil, alt.vehicleId)) {
      throw new Error('Kein Zugriff auf diesen Eintrag.');
    }

    // Die Drive-Kennung eines Belegs vergibt nur der Server beim Hochladen.
    // Kaeme sie aus dem Browser, liesse sich ueber holeBeleg() jede Datei im
    // Drive des Eigentuemers abrufen.
    if (name === 'docs') {
      satz.driveId = alt ? alt.driveId : '';

      // Den Stand der KI-Auswertung fuehrt nur der Server. Der Browser
      // schickt beim Bearbeiten seine - womoeglich aeltere - Kopie mit.
      satz.kiStatus = alt ? alt.kiStatus : '';
      satz.kiFehler = alt ? alt.kiFehler : '';
      satz.kiVersuche = alt ? alt.kiVersuche : '';

      // Neuer Dateiname: auch in Drive umbenennen, sonst stimmen Ablage und
      // Ordner nicht mehr ueberein. Scheitert das, bleibt der alte Name in
      // Drive - der Eintrag wird trotzdem gespeichert.
      if (alt && alt.driveId && satz.name && satz.name !== alt.name) {
        try { DriveApp.getFileById(alt.driveId).setName(String(satz.name)); }
        catch (e) { console.warn('Umbenennen in Drive nicht moeglich: ' + e.message); }
      }
    }
  }

  // Wird ein Termin bearbeitet – etwa weil die Wartung erledigt ist –, faengt
  // die Erinnerung von vorne an. Ohne das bliebe der naechste Zyklus stumm.
  if (name === 'intervals' || name === 'deadlines') satz.reported = '';

  // Ein neuer Kilometerstand aktualisiert auch das Fahrzeug – die Ansichten
  // lesen dort den aktuellen Stand.
  var geschrieben = schreibe_(name, satz);
  if (name === 'kmlog' && satz.km) aktualisiereKmAmFahrzeug_(satz.vehicleId);
  return geschrieben;
}

/** Traegt den juengsten Stand aus dem Verlauf am Fahrzeug nach. */
function aktualisiereKmAmFahrzeug_(vehicleId) {
  var staende = lies_('kmlog').filter(function (k) {
    return k.vehicleId === vehicleId && k.km;
  }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  if (!staende.length) return;

  var fahrzeuge = lies_('vehicles');
  for (var i = 0; i < fahrzeuge.length; i++) {
    if (fahrzeuge[i].id === vehicleId) {
      fahrzeuge[i].km = staende[0].km;
      fahrzeuge[i].kmDate = staende[0].date;
      schreibe_('vehicles', fahrzeuge[i]);
      return;
    }
  }
}

function loesche(daten) {
  var profil = profilAusToken_(daten.token);
  var name = daten.bestand;
  if (!TABELLEN[name]) throw new Error('Unbekannter Datenbestand.');
  if (name === 'profile') throw new Error('Profile werden hier nicht geloescht.');

  var alle = lies_(name);
  var satz = null;
  for (var i = 0; i < alle.length; i++) if (alle[i].id === daten.id) { satz = alle[i]; break; }
  if (!satz) return true;

  if (name === 'vehicles') {
    if (!gehoertMir_(profil, satz.id)) throw new Error('Kein Zugriff auf dieses Fahrzeug.');
    // Alles, was am Fahrzeug haengt, muss mit weg – sonst bleiben Waisen in
    // der Tabelle, die niemand mehr sieht und niemand mehr loeschen kann.
    AM_FAHRZEUG.forEach(function (bestand) {
      lies_(bestand).forEach(function (z) {
        if (z.vehicleId === satz.id) {
          if (bestand === 'docs' && z.driveId) loescheDatei_(z.driveId);
          entferne_(bestand, z.id);
        }
      });
    });
  } else if (name === 'shops') {
    if (profil.rolle !== 'verwalter' && satz.profilId !== profil.id) {
      throw new Error('Kein Zugriff auf diese Werkstatt.');
    }
  } else {
    if (!gehoertMir_(profil, satz.vehicleId)) throw new Error('Kein Zugriff auf dieses Fahrzeug.');
    if (name === 'docs' && satz.driveId) loescheDatei_(satz.driveId);
  }
  return entferne_(name, daten.id);
}

function loescheDatei_(driveId) {
  try { DriveApp.getFileById(driveId).setTrashed(true); }
  catch (e) { /* schon weg */ }
}

/* ================= Dateien ================= */

/**
 * Fuhrpark – Belege und Belegerkennung
 *
 * Belege liegen in einem Drive-Ordner des Eigentuemers, je Fahrzeug ein
 * Unterordner. Der Browser bekommt nie eine Drive-Adresse, sondern laedt
 * Dateien ueber diesen Server – sonst koennte jeder mit der Kennung an die
 * Datei, auch ohne Anmeldung.
 */

var MAX_BYTES = 25 * 1024 * 1024;

/** Unterordner je Fahrzeug, damit der Hauptordner uebersichtlich bleibt. */
function fahrzeugOrdner_(vehicleId, anzeigename) {
  var props = eigenschaften_();
  var schluessel = 'ORDNER_F_' + vehicleId;
  var id = props.getProperty(schluessel);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) {}
  }
  var sperre = LockService.getScriptLock();
  sperre.waitLock(30000);
  try {
    id = props.getProperty(schluessel);
    if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
    var neu = belegOrdner_().createFolder(anzeigename || vehicleId);
    props.setProperty(schluessel, neu.getId());
    return neu;
  } finally {
    sperre.releaseLock();
  }
}

/**
 * Nimmt eine Datei als Base64 entgegen und legt sie ab. Bilder verkleinert der
 * Browser vorher – hier kommt also selten etwas Grosses an.
 */
function ladeBelegHoch(daten) {
  var profil = profilAusToken_(daten.token);
  if (!gehoertMir_(profil, daten.vehicleId)) throw new Error('Kein Zugriff auf dieses Fahrzeug.');

  var bytes = Utilities.base64Decode(daten.base64);
  if (bytes.length > MAX_BYTES) throw new Error('Die Datei ist zu gross (max. 25 MB).');

  var blob = Utilities.newBlob(bytes, daten.mime || 'application/octet-stream',
                               daten.name || 'Beleg');
  var fahrzeug = lies_('vehicles').filter(function (f) { return f.id === daten.vehicleId; })[0];
  var ordner = fahrzeugOrdner_(daten.vehicleId,
    fahrzeug ? (fahrzeug.name || fahrzeug.plate) : null);
  var datei = ordner.createFile(blob);

  return schreibe_('docs', {
    // Immer eine neue Kennung: Eine mitgeschickte haette einen vorhandenen,
    // womoeglich fremden Eintrag ueberschrieben.
    id: null,
    vehicleId: daten.vehicleId,
    category: daten.category || 'Beleg',
    title: daten.title || daten.name || 'Beleg',
    date: daten.date || '',
    name: daten.name || datei.getName(),
    mime: daten.mime || datei.getMimeType(),
    size: bytes.length,
    driveId: datei.getId(),
    // Der Scanner speichert zuerst und laesst danach auslesen. Bis dahin
    // steht der Beleg als "ausstehend" in der Ablage.
    kiStatus: daten.kiAuswerten ? 'ausstehend' : '',
    kiFehler: '',
    kiVersuche: 0
  });
}

/**
 * Liefert eine Datei als Base64 zurueck – nur, wenn sie zu einem Fahrzeug des
 * angemeldeten Profils gehoert.
 */
function holeBeleg(daten) {
  var profil = profilAusToken_(daten.token);
  var dok = lies_('docs').filter(function (d) { return d.id === daten.id; })[0];
  if (!dok) throw new Error('Beleg nicht gefunden.');
  if (!gehoertMir_(profil, dok.vehicleId)) throw new Error('Kein Zugriff auf diesen Beleg.');

  var blob = DriveApp.getFileById(dok.driveId).getBlob();
  return {
    name: dok.name || 'Beleg',
    mime: blob.getContentType(),
    base64: Utilities.base64Encode(blob.getBytes())
  };
}

// ------------------------------------------------------- Belegerkennung (KI)

/**
 * Belege kann entweder Claude oder Gemini auslesen. Beide Schluessel liegen in
 * den Skripteigenschaften, nie im Browser; eingetragen werden sie ueber
 * setzeClaudeSchluessel() bzw. setzeGeminiSchluessel() im Skripteditor.
 *
 * Liegen beide vor, liest Gemini - ueber ERKENNUNG auch andersherum. Der
 * zweite springt NUR ein, wenn das mit setzeErkennungAusweg(true)
 * ausdruecklich erlaubt ist: Claude kostet Geld, und ein Gemini-Ausfall soll
 * nicht stillschweigend Kosten erzeugen. Ohne Ausweg bleibt der Beleg
 * gespeichert und laesst sich spaeter erneut auslesen.
 */
function erkennungStand(daten) {
  // Auch diese Auskunft gibt es nur fuer Angemeldete. Sie verraet zwar nur,
  // ob ein Schluessel hinterlegt ist – aber ohne Pruefung koennte jeder mit
  // dem Link das abfragen, und die Regel "erst anmelden" gilt ueberall gleich.
  // Frueher hiess es hier "if (daten)" - ohne Argument entfiel die Pruefung.
  profilAusToken_(daten);
  return erkennungStand_();
}

/** Dasselbe ohne Anmeldung - nur fuer den Server selbst. */
function erkennungStand_() {
  var props = eigenschaften_();
  var claude = !!props.getProperty('CLAUDE_KEY');
  var gemini = !!props.getProperty('GEMINI_KEY');
  var wunsch = props.getProperty('ERKENNUNG') || '';
  // Ohne Festlegung liest Gemini, weil es ein kostenloses Kontingent hat.
  // Claude ist der Ausweg und kostet nur, wenn Gemini nicht weiterkommt.
  // Wer es andersherum will: setzeErkennung('claude').
  var erster = (wunsch === 'claude' && claude) ? 'claude'
             : (wunsch === 'gemini' && gemini) ? 'gemini'
             : gemini ? 'gemini' : claude ? 'claude' : null;
  var ausweg = props.getProperty('ERKENNUNG_AUSWEG') === 'ja';
  return {
    claude: claude, gemini: gemini, aktiv: erster, ausweg: ausweg,
    zweit: !ausweg ? null
         : erster === 'claude' ? (gemini ? 'gemini' : null)
         : erster === 'gemini' ? (claude ? 'claude' : null) : null
  };
}

function erkennungVorhanden(daten) {
  return !!erkennungStand(daten).aktiv;
}

/** Bleibt, damit eine aeltere bereitgestellte Fassung weiterlaeuft. */
function geminiVorhanden(daten) {
  return erkennungVorhanden(daten);
}

var BELEG_AUFTRAG =
  'Lies diesen Fahrzeugbeleg (Werkstattrechnung, TÜV-Bericht o. ä.) und ' +
  'gib die enthaltenen Angaben zurueck. Was nicht auf dem Beleg steht, ' +
  'laesst du weg – rate nichts. Datumsangaben als JJJJ-MM-TT; steht nur '
  + 'ein Monat da, dann als JJJJ-MM. Es koennen mehrere Seiten desselben '
  + 'Belegs sein - dann gilt alles zusammen, und der Gesamtbetrag steht '
  + 'meist auf der letzten. Kilometerstand, Datum, Betraege, '
  + 'Rechnungsnummer, naechster Termin und Kennzeichen nur angeben, wenn '
  + 'sie ausdruecklich auf dem Beleg stehen - nie aus anderen Angaben '
  + 'errechnen oder schaetzen. Ausgefuehrte Arbeiten von ALLEN Seiten '
  + 'erfassen, je Arbeit ein Eintrag.';

var GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    date:     { type: 'STRING', description: 'Rechnungsdatum als JJJJ-MM-TT' },
    cost:     { type: 'NUMBER', description: 'Gesamtbetrag in Euro' },
    km:       { type: 'NUMBER', description: 'Kilometerstand, falls genannt' },
    shop:     { type: 'STRING', description: 'Name der Werkstatt oder des Haendlers' },
    type:     { type: 'STRING', description: 'Wartung, Reparatur, TÜV/AU, Reifen oder Sonstiges' },
    category: { type: 'STRING', description: 'Rechnung, HU/AU-Bericht, Versicherung oder Sonstiges' },
    title:    { type: 'STRING', description: 'Kurze Bezeichnung, z. B. Ölwechsel + Ölfilter' },
    desc:     { type: 'STRING', description: 'Die ausgefuehrten Arbeiten in einem Satz' },
    plate:    { type: 'STRING', description: 'Kennzeichen, falls auf dem Beleg' },
    nextDue:  { type: 'STRING', description: 'Naechster Termin als JJJJ-MM-TT. '
                + 'Steht nur ein Monat da - bei der HU die Regel, etwa "Januar 2027" -, '
                + 'dann als JJJJ-MM angeben. Nicht raten.' },
    maintenanceKinds: { type: 'ARRAY', items: { type: 'STRING' },
                        description: 'Welche Wartungen erledigt wurden, z. B. Ölwechsel' },
    // Neu. Jedes Feld hat in der App einen Platz: Rechnungsnummer und
    // Betraege landen in der Notiz, die Arbeiten in der Beschreibung.
    invoiceNumber: { type: 'STRING', description: 'Rechnungsnummer, genau wie auf dem Beleg' },
    netAmount:     { type: 'NUMBER', description: 'Nettobetrag in Euro, falls ausgewiesen' },
    vatAmount:     { type: 'NUMBER', description: 'Mehrwertsteuer in Euro, falls ausgewiesen' },
    workPerformed: { type: 'ARRAY', items: { type: 'STRING' },
                     description: 'Ausgefuehrte Arbeiten von allen Seiten, je Arbeit ein Eintrag, '
                       + 'z. B. "Zahnriemen erneuert"' }
  }
};

/**
 * Dasselbe Schema noch einmal in der Schreibweise, die Claude erwartet:
 * gewoehnliches JSON Schema mit kleingeschriebenen Typen.
 */
var CLAUDE_SCHEMA = (function () {
  var p = {}, q = GEMINI_SCHEMA.properties;
  Object.keys(q).forEach(function (name) {
    var f = q[name];
    p[name] = f.type === 'ARRAY'
      ? { type: 'array', items: { type: 'string' }, description: f.description }
      : { type: String(f.type).toLowerCase(), description: f.description };
  });
  return { type: 'object', properties: p };
})();

/**
 * Schickt den Beleg an die Erkennung und gibt die gefundenen Felder zurueck.
 * Das Ergebnis ist ausdruecklich nur ein Vorschlag – die App zeigt es zur
 * Kontrolle an, bevor etwas gespeichert wird.
 */
function erkenneBeleg(daten) {
  profilAusToken_(daten.token);
  return erkenneMitAnbietern_(daten);
}

/**
 * Fragt den eingestellten Dienst. Den zweiten nur, wenn der Ausweg
 * ausdruecklich erlaubt ist (siehe erkennungStand_).
 */
function erkenneMitAnbietern_(daten) {
  var stand = erkennungStand_();
  if (!stand.aktiv) {
    throw new Error('Kein Schluessel fuer die Belegerkennung hinterlegt. Siehe Einrichtung.');
  }
  var lese = function (welcher) {
    return welcher === 'claude' ? erkenneMitClaude_(daten) : erkenneMitGemini_(daten);
  };
  var erstes;
  try {
    erstes = lese(stand.aktiv);
  } catch (e) {
    // Ausweg, wenn der erste ueberlastet ist oder das Guthaben fehlt.
    // Gibt es keinen, bleibt der urspruengliche Fehler.
    if (!stand.zweit) throw e;
    console.warn('Erkennung mit ' + stand.aktiv + ' gescheitert, versuche ' + stand.zweit + ': ' + e.message);
    return lese(stand.zweit);
  }
  // "Nicht weitergekommen" heisst nicht nur "Fehler": Ein Beleg, von dem nichts
  // Brauchbares zurueckkommt, ist genauso ein Fall fuer den zweiten. Bringt der
  // auch nichts, bleibt es beim ersten Ergebnis.
  if (stand.zweit && ausbeute_(erstes) === 0) {
    try {
      var zweites = lese(stand.zweit);
      if (ausbeute_(zweites) > 0) return zweites;
    } catch (e2) {}
  }
  return erstes;
}

/*
 * Gemini nimmt eingebettete Dateien nur bis etwa 20 MB je Anfrage an - und
 * das als Base64, also um ein Drittel aufgeblaeht. Darueber ist die Antwort
 * immer ein Fehler; besser vorher sagen, woran es liegt.
 */
var KI_MAX_BYTES = 14 * 1024 * 1024;

/**
 * Liest einen bereits gespeicherten Beleg aus - direkt aus Drive, ohne dass
 * der Browser die Datei noch einmal schicken muss.
 *
 * Wirft nur, wenn der Zugriff nicht stimmt. Scheitert die Erkennung, kommt
 * { fehler } zurueck und der Beleg bleibt, wie er ist: Er ist gespeichert,
 * nur eben noch nicht ausgelesen.
 *
 * @returns {{dok: object, ergebnis: object|null, fehler: string|null}}
 */
function liesBelegAus(daten) {
  var profil = profilAusToken_(daten.token);
  var dok = lies_('docs').filter(function (d) { return d.id === daten.id; })[0];
  if (!dok) throw new Error('Beleg nicht gefunden.');
  if (!gehoertMir_(profil, dok.vehicleId)) throw new Error('Kein Zugriff auf diesen Beleg.');
  if (!dok.driveId) throw new Error('Zu diesem Eintrag gibt es keine Datei.');

  if (!erkennungStand_().aktiv) {
    return { dok: dok, ergebnis: null,
             fehler: 'Für die automatische Auswertung ist kein Schlüssel hinterlegt.' };
  }

  var ergebnis = null, fehler = null;
  try {
    var blob = DriveApp.getFileById(dok.driveId).getBlob();
    var mime = blob.getContentType() || dok.mime || '';
    var bytes = blob.getBytes();
    if (!/^(application\/pdf|image\/)/.test(mime)) {
      throw new Error('Diese Dateiart (' + mime + ') kann die automatische Auswertung nicht lesen.');
    }
    if (bytes.length > KI_MAX_BYTES) {
      throw new Error('Das Dokument ist für die automatische Auswertung zu groß (über '
        + Math.round(KI_MAX_BYTES / 1024 / 1024) + ' MB). Es bleibt gespeichert.');
    }
    ergebnis = erkenneMitAnbietern_({ seiten: [{ base64: Utilities.base64Encode(bytes), mime: mime }] });
  } catch (e) {
    fehler = e.message || String(e);
    console.error('Auslesen von Beleg ' + dok.id + ' gescheitert: ' + fehler);
  }

  dok.kiStatus = fehler ? 'fehlgeschlagen' : 'fertig';
  dok.kiFehler = fehler || '';
  dok.kiVersuche = (Number(dok.kiVersuche) || 0) + 1;
  schreibe_('docs', dok);
  return { dok: dok, ergebnis: ergebnis, fehler: fehler };
}

/** Wie viele der Felder gefuellt sind, auf die es beim Uebernehmen ankommt. */
function ausbeute_(r) {
  if (!r) return 0;
  return ['date', 'cost', 'title', 'shop', 'km'].filter(function (f) {
    return r[f] !== null && r[f] !== undefined && r[f] !== '';
  }).length;
}

/*
 * Voruebergehende Stoerungen. 429 heisst "zu viele Anfragen", 503 "das
 * Modell ist gerade ueberlastet" - beides sagt nichts ueber den Beleg oder
 * den Schluessel aus und ist oft nach Sekunden vorbei. Aufgeben waere hier
 * das Falsche.
 */
var VORUEBERGEHEND = [429, 500, 502, 503, 504, 529];

/**
 * Ruft eine Adresse und wiederholt bei voruebergehenden Stoerungen.
 *
 * Gewartet wird zwischen den Versuchen immer laenger (1, dann 3 Sekunden):
 * Sofort nachzuhaken verschaerft eine Ueberlastung nur. Mehr als drei
 * Versuche lohnen nicht - Apps Script bricht eine Ausfuehrung nach sechs
 * Minuten ohnehin ab, und der Mensch davor wartet nicht ewig.
 */
function holeMitGeduld_(adresse, einstellungen, eigeneWartezeiten) {
  var wartezeiten = eigeneWartezeiten || [1000, 3000];
  var antwort = null;
  for (var versuch = 0; versuch <= wartezeiten.length; versuch++) {
    antwort = UrlFetchApp.fetch(adresse, einstellungen);
    if (VORUEBERGEHEND.indexOf(antwort.getResponseCode()) === -1) return antwort;
    if (versuch < wartezeiten.length) Utilities.sleep(wartezeiten[versuch]);
  }
  return antwort;
}

/*
 * Mehrere Modelle nacheinander.
 *
 * "Ueberlastet" trifft immer ein bestimmtes Modell, nicht den ganzen
 * Dienst. Ist gemini-flash-latest gerade voll, antwortet ein anderes oft
 * sofort. Ein einziges Modell zu befragen und dann aufzugeben macht die
 * Erkennung unzuverlaessiger, als sie sein muesste.
 *
 * Eigene Reihenfolge ueber die Skripteigenschaft GEMINI_MODELLE, durch
 * Komma getrennt. Welche es gibt, zeigt pruefeGemini().
 */
/* Stand September 2026. gemini-2.0-flash ist abgeschaltet, gemini-2.5-flash
   nur noch fuer Konten erreichbar, die es frueher benutzt haben - deshalb
   die 404. "gemini-flash-latest" steht als Netz dahinter: Google tauscht
   dahinter bei jeder Veroeffentlichung das aktuelle Modell ein.
   Welche Namen der eigene Schluessel wirklich erreicht, zeigt
   pruefeGemini(); abweichen laesst sich ueber GEMINI_MODELLE. */
var GEMINI_MODELLE = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];

function geminiModelle_() {
  var eigene = (eigenschaften_().getProperty('GEMINI_MODELLE') || '').split(',')
    .map(function (m) { return m.trim(); }).filter(Boolean);
  return eigene.length ? eigene : GEMINI_MODELLE;
}

/**
 * Die Seiten eines Belegs, wie der Browser sie geschickt hat.
 *
 * Neu kommt "seiten" als Liste. Aeltere Bereitstellungen kannten nur eine
 * einzelne Datei in base64/mime - die Form bleibt gueltig, damit ein noch
 * nicht ausgetauschter Browser weiterarbeitet.
 */
function belegSeiten_(daten) {
  if (daten.seiten && daten.seiten.length) return daten.seiten;
  if (daten.base64) return [{ base64: daten.base64, mime: daten.mime }];
  return [];
}

function erkenneMitGemini_(daten) {
  var schluessel = eigenschaften_().getProperty('GEMINI_KEY');
  // Alle Seiten in einer Anfrage - das Modell sieht den Beleg im
  // Zusammenhang, statt Seite fuer Seite geraten zu muessen.
  var teile = [{ text: BELEG_AUFTRAG }];
  belegSeiten_(daten).forEach(function (s) {
    teile.push({ inline_data: { mime_type: s.mime, data: s.base64 } });
  });

  var anfrage = {
    contents: [{ parts: teile }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_SCHEMA,
      temperature: 0
    }
  };
  var einstellungen = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': schluessel },
    payload: JSON.stringify(anfrage),
    muteHttpExceptions: true
  };

  var modelle = geminiModelle_();
  var beginn = Date.now();
  var letzter = null;
  var alleUnbekannt = true;

  for (var i = 0; i < modelle.length; i++) {
    var adresse = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  modelle[i] + ':generateContent';
    for (var versuch = 0; ; versuch++) {
      var antwort = UrlFetchApp.fetch(adresse, einstellungen);
      var code = antwort.getResponseCode();
      if (code === 200) {
        var ergebnis = JSON.parse(antwort.getContentText());
        var text = ergebnis.candidates && ergebnis.candidates[0] &&
                   ergebnis.candidates[0].content.parts[0].text;
        if (!text) throw new Error('Auf dem Beleg war nichts Verwertbares zu finden.');
        return JSON.parse(text);
      }

      letzter = geminiFehler_(antwort);
      if (code !== 404) alleUnbekannt = false;
      // Googles eigene Begruendung gehoert ins Protokoll, nicht vor den Nutzer.
      console.warn('Gemini ' + modelle[i] + ', Versuch ' + (versuch + 1) + ': ' + code +
                   (letzter.status ? ' ' + letzter.status : '') +
                   (letzter.grund ? ' - ' + letzter.grund : ''));

      // Am Modell liegt es bei "gibt es nicht" (404) und bei einem
      // erschoepften Tageskontingent - jedes Modell hat sein eigenes. Dann
      // gleich das naechste, Warten hilft nicht.
      if (code === 404 || letzter.tageskontingent) break;

      // 400, 401, 403: Schluessel, Gesuch oder Schema stimmen nicht. Das
      // waere bei jedem Modell und jedem Versuch genauso - aufhoeren.
      if (VORUEBERGEHEND.indexOf(code) === -1) throw new Error(geminiMeldung_(letzter));

      // Voruebergehend. Vor dem letzten Modell ist der Wechsel schneller als
      // jede Pause; beim letzten wird mit wachsendem Abstand wiederholt.
      if (i < modelle.length - 1) break;
      var warte = wartezeit_(versuch, letzter.warteMs);
      if (warte === null || Date.now() - beginn + warte > GEMINI_ZEITRAHMEN_MS) break;
      Utilities.sleep(warte);
    }
  }

  if (alleUnbekannt) {
    throw new Error('Keines der eingestellten Modelle gibt es: ' + modelle.join(', ') +
                    '. Im Skripteditor pruefeGemini() ausführen – es listet die ' +
                    'verfügbaren auf. Die gewünschten dann als Skripteigenschaft ' +
                    'GEMINI_MODELLE eintragen, durch Komma getrennt.');
  }
  throw new Error(geminiMeldung_(letzter));
}

/*
 * Wiederholen bei voruebergehenden Stoerungen: etwa 2, 4, 8 Sekunden, mit
 * etwas Zufall, damit nicht mehrere Aufrufe im Gleichschritt wiederkommen.
 * Insgesamt nicht laenger als eine Minute - davor sitzt ein Mensch.
 */
var GEMINI_WARTEN_MS = [2000, 4000, 8000];
var GEMINI_ZEITRAHMEN_MS = 60000;

/** Wartezeit vor dem naechsten Versuch, oder null, wenn es keinen mehr gibt. */
function wartezeit_(versuch, vorgabeMs) {
  if (versuch >= GEMINI_WARTEN_MS.length) return null;
  // Nennt Google selbst eine Wartezeit, gilt die - aber nicht ueber 20 s.
  if (vorgabeMs !== null && vorgabeMs !== undefined) return vorgabeMs > 20000 ? null : vorgabeMs;
  return Math.round(GEMINI_WARTEN_MS[versuch] * (1 + Math.random() * 0.25));
}

/**
 * Was hinter einer Fehlerantwort steckt.
 *
 * 429 ist nicht gleich 429: Ein Minutenlimit ist nach Sekunden vorbei, ein
 * aufgebrauchtes Tageskontingent erst morgen. Google schreibt das in die
 * Einzelheiten der Antwort (QuotaFailure, RetryInfo).
 */
function geminiFehler_(antwort) {
  var f = { code: antwort.getResponseCode(), status: '', grund: '',
            tageskontingent: false, warteMs: null };
  var fehler = null;
  try { fehler = JSON.parse(antwort.getContentText()).error; } catch (e) {}
  if (!fehler) return f;
  f.status = fehler.status || '';
  f.grund = fehler.message || '';
  (fehler.details || []).forEach(function (d) {
    var typ = String(d['@type'] || '');
    if (/RetryInfo$/.test(typ) && d.retryDelay) {
      var sek = parseFloat(String(d.retryDelay));
      if (!isNaN(sek)) f.warteMs = Math.round(sek * 1000);
    }
    if (/QuotaFailure$/.test(typ)) {
      (d.violations || []).forEach(function (v) {
        if (/PerDay/i.test(String(v.quotaId || ''))) f.tageskontingent = true;
      });
    }
  });
  if (f.code === 429 && /per day|daily/i.test(f.grund)) f.tageskontingent = true;
  return f;
}

/** Verstaendliche Meldung - der genaue Grund steht im Protokoll. */
function geminiMeldung_(f) {
  if (!f) return 'Gemini antwortet nicht.';
  if (f.code === 429 && f.tageskontingent) {
    return 'Das Tageskontingent der automatischen Auswertung ist aufgebraucht. '
         + 'Bitte morgen erneut auslesen.';
  }
  if (f.code === 429) {
    return 'Die automatische Auswertung nimmt gerade keine weiteren Anfragen an '
         + '(Anfragelimit). Bitte in einigen Minuten erneut versuchen.';
  }
  if (VORUEBERGEHEND.indexOf(f.code) >= 0) {
    return 'Die automatische Auswertung ist momentan nicht verfügbar (Gemini, Fehler '
         + f.code + '). Bitte später erneut versuchen.';
  }
  if (f.code === 401 || f.code === 403 || /api key/i.test(f.grund)) {
    return 'Der Gemini-Schlüssel wird abgelehnt (Fehler ' + f.code + '). '
         + 'Im Skripteditor pruefeGemini() ausführen.';
  }
  return 'Gemini lehnt die Anfrage ab (Fehler ' + f.code + (f.grund ? ': ' + f.grund : '') + ').';
}

/**
 * Claude bekommt den Beleg als Bild oder – bei PDF – als Dokument und
 * antwortet ueber ein Werkzeug. Das erzwingt dieselben Felder wie bei Gemini,
 * statt sie aus Fliesstext herauszulesen.
 */
function erkenneMitClaude_(daten) {
  var schluessel = eigenschaften_().getProperty('CLAUDE_KEY');
  var inhalt = belegSeiten_(daten).map(function (s) {
    var mime = s.mime || 'image/jpeg';
    return mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: s.base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mime,              data: s.base64 } };
  });

  var antwort = holeMitGeduld_('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': schluessel, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: eigenschaften_().getProperty('CLAUDE_MODELL') || 'claude-sonnet-5',
      // Kein temperature: Claude Sonnet 5 und neuer lehnen den Parameter mit
      // Fehler 400 ab - die Erkennung waere bei jedem Beleg gescheitert.
      // Ebenso wichtig: Neuere Modelle (Sonnet 5.5, Opus 5.5) erlauben das
      // erzwungene tool_choice unten nicht mehr. Wer CLAUDE_MODELL auf so ein
      // Modell stellt, muss tool_choice auf 'auto' umbauen.
      max_tokens: 1024,
      tools: [{ name: 'beleg', description: 'Die auf dem Beleg gefundenen Angaben.',
                input_schema: CLAUDE_SCHEMA }],
      tool_choice: { type: 'tool', name: 'beleg' },
      messages: [{ role: 'user', content: inhalt.concat([{ type: 'text', text: BELEG_AUFTRAG }]) }]
    }),
    muteHttpExceptions: true
  });

  if (antwort.getResponseCode() !== 200) {
    var fehler = '';
    try { fehler = JSON.parse(antwort.getContentText()).error.message; } catch (e) {}
    throw new Error('Claude antwortet nicht (Fehler ' + antwort.getResponseCode() +
                    (fehler ? ': ' + fehler : '') + ').');
  }
  var inhalt = (JSON.parse(antwort.getContentText()).content || []).filter(function (t) {
    return t.type === 'tool_use';
  })[0];
  if (!inhalt) throw new Error('Auf dem Beleg war nichts Verwertbares zu finden.');
  return inhalt.input || {};
}

/* ================= Erinnerung ================= */

/**
 * Fuhrpark – Erinnerungen per Mail
 *
 * Die groesste Luecke der bisherigen App: Sie meldete sich nie von selbst. Man
 * erfuhr nur etwas, wenn man sie oeffnete. Bei mehreren Fahrzeugen ist genau
 * das der Punkt, an dem man sich nicht mehr auf das Gedaechtnis verlassen kann.
 *
 * Hier prueft ein taeglicher Auftrag alle Termine und schickt eine Mail, wenn
 * einer eine neue Dringlichkeitsstufe erreicht. Nur dann – sonst kaeme taeglich
 * dieselbe Nachricht und man wuerde sie nach einer Woche ignorieren.
 */

/* Ab wie vielen Tagen vorher gemeldet wird. Von grob nach dringend.
   Gemeldet wird nur innerhalb der Vorwarnzeit des jeweiligen Termins: Wer
   bei einem Oelwechsel eine Woche vorher erinnert werden will, soll nicht
   zwei Monate vorher die erste Mail bekommen. */
var STUFEN = [180, 90, 60, 30, 14, 7, 1, 0];

// Vorwarnzeit, wenn am Termin nichts eingestellt ist. Dieselbe Zahl steht in
// app.html (intStatus) – Ansicht und Mail duerfen nicht auseinanderlaufen.
var VORWARNUNG_STANDARD = 30;

function vorwarnungFuer_(satz) {
  var eigen = satz.leadDays;
  if (eigen === '' || eigen === null || eigen === undefined) return VORWARNUNG_STANDARD;
  var zahl = Number(eigen);
  return isNaN(zahl) ? VORWARNUNG_STANDARD : zahl;
}

function heuteNull_() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Wandelt "JJJJ-MM-TT" in ein Datum. Ungueltige Angaben wie der 29. Februar in
 * einem Nicht-Schaltjahr werden abgelehnt statt stillschweigend in den
 * Folgemonat verschoben – sonst erschiene ein Termin im Maerz, den niemand so
 * eingetragen hat. Das kann vorkommen, wenn jemand direkt in der Tabelle tippt.
 */
function alsDatum_(text) {
  if (!text) return null;
  var teile = String(text).slice(0, 10).split('-');
  if (teile.length !== 3) return null;
  var jahr = +teile[0], monat = +teile[1], tag = +teile[2];
  if (!jahr || !monat || !tag) return null;
  var d = new Date(jahr, monat - 1, tag);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() !== jahr || d.getMonth() !== monat - 1 || d.getDate() !== tag) return null;
  return d;
}

function tageBis_(datum) {
  return Math.round((datum - heuteNull_()) / 86400000);
}

/**
 * Addiert Monate und bleibt dabei im Zielmonat. Das eingebaute setMonth laesst
 * den Tag ueberlaufen: 31. Januar plus ein Monat ergibt dort den 2. oder
 * 3. Maerz, weil der Februar keinen 31. hat. Fuer Wartungstermine ist das
 * falsch – gemeint ist das Monatsende.
 */
function plusMonate_(datum, monate) {
  var tag = datum.getDate();
  var ziel = new Date(datum.getTime());
  ziel.setDate(1);
  ziel.setMonth(ziel.getMonth() + monate);
  var letzterTag = new Date(ziel.getFullYear(), ziel.getMonth() + 1, 0).getDate();
  ziel.setDate(Math.min(tag, letzterTag));
  return ziel;
}

/**
 * Schaetzt die taegliche Fahrleistung aus den erfassten Kilometerstaenden. Mit
 * weniger als zwei Staenden ist keine Aussage moeglich – dann liefert die
 * Funktion 0 und Kilometertermine bleiben ohne Datum.
 */
function kmProTagFuer_(vehicleId, kmlog) {
  var meine = kmlog
    .filter(function (k) { return k.vehicleId === vehicleId && k.date && k.km; })
    .sort(function (a, b) { return alsDatum_(a.date) - alsDatum_(b.date); });
  if (meine.length < 2) return 0;

  var erst = meine[0], letzt = meine[meine.length - 1];
  var tage = (alsDatum_(letzt.date) - alsDatum_(erst.date)) / 86400000;
  var km = Number(letzt.km) - Number(erst.km);
  if (tage <= 0 || km <= 0) return 0;
  return km / tage;
}

function aktuellerKm_(fahrzeug, kmlog) {
  var meine = kmlog
    .filter(function (k) { return k.vehicleId === fahrzeug.id && k.km; })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  if (meine.length) return Number(meine[0].km);
  return Number(fahrzeug.km) || 0;
}

/**
 * Rechnet aus Intervall und letzter Ausfuehrung die naechste Faelligkeit.
 * Gibt es beide Angaben – Kilometer und Monate –, gilt die, die frueher
 * eintritt. Das entspricht dem, was Werkstaetten "je nachdem, was zuerst
 * eintritt" nennen.
 */
function naechsteFaelligkeit_(iv, kmProTag, jetztKm) {
  var ergebnis = { datum: null, km: null, tage: null };

  // Ein fest eingetragener Termin geht vor – er steht auf der Plakette oder
  // im Brief und muss nicht aus dem letzten Mal zurueckgerechnet werden.
  if (iv.dueDate) {
    var fest = alsDatum_(iv.dueDate);
    if (fest) {
      ergebnis.datum = fest;
      ergebnis.tage = tageBis_(fest);
      return ergebnis;
    }
  }

  if (iv.lastDate && iv.intervalMonths) {
    var basis = alsDatum_(iv.lastDate);
    if (basis) {
      var d = plusMonate_(basis, Number(iv.intervalMonths));
      ergebnis.datum = d;
      ergebnis.tage = tageBis_(d);
    }
  }
  if (iv.lastKm && iv.intervalKm) {
    ergebnis.km = Number(iv.lastKm) + Number(iv.intervalKm);
    // Ohne bekannte Fahrleistung laesst sich der Kilometertermin nicht in Tage
    // uebersetzen – dann bleibt es beim Datumstermin.
    if (kmProTag > 0) {
      var tageKm = Math.round((ergebnis.km - jetztKm) / kmProTag);
      if (ergebnis.tage === null || tageKm < ergebnis.tage) {
        ergebnis.tage = tageKm;
        var dk = new Date(heuteNull_().getTime() + tageKm * 86400000);
        if (ergebnis.datum === null || dk < ergebnis.datum) ergebnis.datum = dk;
      }
    }
  }
  return ergebnis;
}

/**
 * Welche Dringlichkeitsstufe ist erreicht? Kleinere Zahl heisst dringender.
 * Gesucht ist die dringendste Stufe, die der Termin schon erreicht hat – bei
 * 5 Tagen Rest also 7, nicht 60.
 */
function stufeFuer_(tage, vorwarn) {
  if (tage === null || tage === undefined) return null;
  var grenze = (vorwarn === undefined || vorwarn === null) ? VORWARNUNG_STANDARD : vorwarn;
  // Ausserhalb der eingestellten Vorwarnzeit wird gar nicht gemeldet.
  if (tage > grenze) return null;
  var beste = null;
  for (var i = 0; i < STUFEN.length; i++) {
    if (STUFEN[i] > grenze) continue;
    if (tage <= STUFEN[i] && (beste === null || STUFEN[i] < beste)) beste = STUFEN[i];
  }
  // Steht die Vorwarnzeit zwischen zwei Stufen, gilt sie selbst als erste.
  if (beste === null) beste = grenze;
  return beste;
}

/** Taeglicher Auftrag. Einrichten ueber richteErinnerungEin(). */
function taeglichePruefung() {
  raeumeSitzungenAuf_();

  var profile = lies_('profile').filter(function (p) { return p.email; });
  if (!profile.length) return;

  var fahrzeuge = lies_('vehicles');
  var intervals = lies_('intervals');
  var deadlines = lies_('deadlines');
  var kmlog = lies_('kmlog');

  profile.forEach(function (profil) {
    var meine = profil.rolle === 'verwalter' ? fahrzeuge
      : fahrzeuge.filter(function (f) { return f.profilId === profil.id; });
    if (!meine.length) return;

    var faellig = [];

    meine.forEach(function (f) {
      var proTag = kmProTagFuer_(f.id, kmlog);
      var jetztKm = aktuellerKm_(f, kmlog);

      intervals.filter(function (iv) { return iv.vehicleId === f.id; }).forEach(function (iv) {
        var n = naechsteFaelligkeit_(iv, proTag, jetztKm);
        var vorwarn = vorwarnungFuer_(iv);
        var stufe = n.tage === null ? null : stufeFuer_(n.tage, vorwarn);

        // Kilometertermine wie in der App: bald faellig ab VORWARNUNG_KM
        // Rest, ueberfaellig unter null. Frueher zaehlten Kilometer hier nur,
        // wenn sich aus zwei Kilometerstaenden eine Fahrleistung schaetzen
        // liess - ohne diesen Verlauf kam fuer einen reinen Kilometertermin
        // nie eine Mail, obwohl die App ihn laengst rot zeigte.
        var kmRest = (n.km !== null && jetztKm > 0) ? n.km - jetztKm : null;
        if (kmRest !== null && kmRest <= VORWARNUNG_KM) {
          var kmStufe = kmRest < 0 ? 0 : stufeFuer_(vorwarn, vorwarn);
          if (stufe === null || kmStufe < stufe) stufe = kmStufe;
        }
        if (stufe === null) return;
        var schon = (iv.reported === '' || iv.reported === null) ? null : Number(iv.reported);
        if (schon !== null && schon <= stufe) return;
        faellig.push({ fahrzeug: f, kind: iv.kind, tage: n.tage, datum: n.datum,
                       kmRest: kmRest, bestand: 'intervals', id: iv.id, stufe: stufe });
      });

      deadlines.filter(function (fr) { return fr.vehicleId === f.id; }).forEach(function (fr) {
        var d = alsDatum_(fr.date);
        if (!d) return;
        var tage = tageBis_(d);
        var stufe = stufeFuer_(tage, vorwarnungFuer_(fr));
        if (stufe === null) return;
        var schon = (fr.reported === '' || fr.reported === null) ? null : Number(fr.reported);
        if (schon !== null && schon <= stufe) return;
        faellig.push({ fahrzeug: f, kind: fr.kind, tage: tage, datum: d,
                       bestand: 'deadlines', id: fr.id, stufe: stufe });
      });
    });

    if (!faellig.length) return;
    faellig.sort(function (a, b) { return dringlichkeit_(a) - dringlichkeit_(b); });

    // Scheitert der Versand fuer ein Profil - etwa wegen einer vertippten
    // Adresse -, sollen die uebrigen ihre Mail trotzdem bekommen. Frueher
    // brach hier die ganze Schleife ab.
    try {
      sendeErinnerung_(profil, faellig);
    } catch (e) {
      console.error('Erinnerung an ' + profil.name + ' nicht versandt: ' + e.message);
      return;
    }

    // Erst nach erfolgreichem Versand vermerken – sonst faellt eine Meldung
    // aus, wenn der Mailversand scheitert.
    faellig.forEach(function (p) {
      var bestand = lies_(p.bestand);
      for (var i = 0; i < bestand.length; i++) {
        if (bestand[i].id === p.id) {
          bestand[i].reported = p.stufe;
          schreibe_(p.bestand, bestand[i]);
          break;
        }
      }
    });
  });
}

/** Ab hier zaehlt der Kilometerstand statt des Datums. */
var VORWARNUNG_KM = 1000;   // dieselbe Zahl steht in app.html (intStatus)

function hatKmRest_(p) {
  return p.kmRest !== null && p.kmRest !== undefined;
}

function ueberfaellig_(p) {
  return (p.tage !== null && p.tage < 0) || (hatKmRest_(p) && p.kmRest < 0);
}

/** Sortierschluessel: Ueberfaelliges zuerst, dann nach Resttagen. */
function dringlichkeit_(p) {
  if (ueberfaellig_(p)) return Math.min(p.tage === null ? 0 : p.tage, 0) - 100000;
  return p.tage === null ? 0 : p.tage;
}

/** Nutzereingaben fuer die Mail - sie wird als HTML verschickt. */
function maskiere_(text) {
  return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (z) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z];
  });
}

/** "in 12 Tagen", "noch 800 km" - im Betreff ohne Auszeichnung. */
function wannText_(p, alsHtml) {
  var rot = function (t) { return alsHtml ? '<b style="color:#9E332A">' + t + '</b>' : t; };
  var kmText = hatKmRest_(p)
    ? new Intl.NumberFormat('de-DE').format(Math.abs(Math.round(p.kmRest))) + ' km'
    : '';
  if (p.tage !== null && p.tage < 0) return rot(Math.abs(p.tage) + ' Tage überfällig');
  if (hatKmRest_(p) && p.kmRest < 0) return rot(kmText + ' überzogen');
  if (hatKmRest_(p) && p.kmRest <= VORWARNUNG_KM) {
    return 'noch ' + kmText + (p.tage !== null ? ' / ' + p.tage + ' Tage' : '');
  }
  return 'in ' + p.tage + ' Tagen';
}

function sendeErinnerung_(profil, punkte) {
  var ueberfaellig = punkte.filter(ueberfaellig_);
  var betreff = ueberfaellig.length
    ? 'Fuhrpark: ' + ueberfaellig.length + ' überfällig'
    : 'Fuhrpark: ' + punkte[0].kind + ' – ' + wannText_(punkte[0], false);

  var zeilen = punkte.map(function (p) {
    var wann = wannText_(p, true);
    var datum = p.datum ? Utilities.formatDate(p.datum, zeitzone_(), 'dd.MM.yyyy') : '';
    return '<tr>' +
      '<td style="padding:8px 12px 8px 0;border-bottom:1px solid #D6D6CC">' +
        '<b>' + maskiere_(p.kind) + '</b><br><span style="color:#7A7A70;font-size:13px">' +
        maskiere_(p.fahrzeug.name || p.fahrzeug.plate || '') + '</span></td>' +
      '<td style="padding:8px 0;border-bottom:1px solid #D6D6CC;text-align:right">' +
        wann + '<br><span style="color:#7A7A70;font-size:13px">' + datum + '</span></td>' +
      '</tr>';
  }).join('');

  var html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;color:#22221D">' +
    '<p style="font-size:17px;margin:0 0 4px"><b>Fuhrpark</b></p>' +
    '<p style="color:#7A7A70;margin:0 0 18px">Hallo ' + maskiere_(profil.name) + ', das steht an:</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:15px">' + zeilen + '</table>' +
    '<p style="color:#7A7A70;font-size:13px;margin:20px 0 0">' +
    'Diese Nachricht kommt einmal je Termin und Dringlichkeitsstufe, nicht täglich.</p>' +
    '</div>';

  MailApp.sendEmail({ to: profil.email, subject: betreff, htmlBody: html, name: 'Fuhrpark' });
}

/** Einmal im Skripteditor ausfuehren, um den taeglichen Auftrag anzulegen. */
function richteErinnerungEin() {
  nurImEditor_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'taeglichePruefung') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('taeglichePruefung').timeBased().atHour(7).everyDays(1).create();
  return 'Tägliche Prüfung eingerichtet – läuft jeden Morgen gegen 7 Uhr.';
}

/* ================= Einrichtung ================= */

/**
 * Fuhrpark – Einrichtung und Verwaltung
 *
 * Diese Funktionen werden nicht aus der App heraus aufgerufen, sondern von
 * Hand im Skripteditor. Sie sind der einzige Weg, Profile und Passwoerter zu
 * aendern – damit kann niemand ueber die Web-App an die Verwaltung.
 *
 * Reihenfolge beim ersten Mal:
 *   1. ersteEinrichtung()          – legt Tabelle, Ordner und Blaetter an
 *   2. legeProfilAn(...)           – je Person einmal
 *   3. setzeClaudeSchluessel(...)  – optional, fuer die Belegerkennung
 *      oder setzeGeminiSchluessel(...)
 *   4. richteErinnerungEin()       – optional, fuer die Mails
 *   5. Bereitstellen als Web-App
 */

function ersteEinrichtung() {
  nurImEditor_();
  var ss = mappe_();
  Object.keys(TABELLEN).forEach(function (name) { blatt_(name); });
  var ordner = belegOrdner_();
  return [
    'Fertig.',
    'Tabelle: ' + ss.getUrl(),
    'Belegordner: ' + ordner.getUrl(),
    '',
    'Naechster Schritt: legeProfilAn("Lukas", "lukas@example.de", "deinPasswort", "verwalter")'
  ].join('\n');
}

/**
 * Legt ein Profil an. Das Passwort wird nicht gespeichert, nur ein gesalzener
 * Hashwert – auch wer die Tabelle in die Haende bekommt, kann es nicht lesen.
 *
 * rolle: "verwalter" sieht alle Fahrzeuge, alles andere nur die eigenen.
 */
function legeProfilAn(name, email, passwort, rolle) {
  nurImEditor_();
  if (!name || !passwort) throw new Error('Name und Passwort sind noetig.');
  if (String(passwort).length < 8) throw new Error('Bitte mindestens 8 Zeichen.');

  var vorhanden = lies_('profile').filter(function (p) {
    return String(p.name).toLowerCase() === String(name).toLowerCase();
  });
  if (vorhanden.length) throw new Error('Ein Profil mit diesem Namen gibt es schon.');

  var salt = Utilities.getUuid();
  // Farben aus der Gestaltungspalette, damit die Profilbilder zum Rest passen.
  var farben = ['#EC663E', '#4F7A4A', '#2F73BE', '#D8A01F', '#B23B1C', '#2E7D5B'];
  var anzahl = lies_('profile').length;

  var profil = {
    id: neueId_(),
    name: name,
    farbe: farben[anzahl % farben.length],
    email: email || '',
    salt: salt,
    hash: hashe_(String(passwort), salt, HASH_RUNDEN),
    runden: HASH_RUNDEN,
    hashArt: 'bytes',
    rolle: rolle || 'nutzer',
    angelegt: new Date().toISOString()
  };
  schreibe_('profile', profil);
  return 'Profil "' + name + '" angelegt' + (email ? ' (Erinnerungen an ' + email + ')' : '') + '.';
}

/** Setzt ein Passwort neu. Es gibt keine "Passwort vergessen"-Mail. */
function setzePasswort(name, neuesPasswort) {
  nurImEditor_();
  if (String(neuesPasswort || '').length < 8) throw new Error('Bitte mindestens 8 Zeichen.');
  var profile = lies_('profile');
  for (var i = 0; i < profile.length; i++) {
    if (String(profile[i].name).toLowerCase() === String(name).toLowerCase()) {
      profile[i].salt = Utilities.getUuid();
      profile[i].runden = HASH_RUNDEN;
      profile[i].hashArt = 'bytes';
      profile[i].hash = hashe_(String(neuesPasswort), profile[i].salt, HASH_RUNDEN);
      schreibe_('profile', profile[i]);
      meldeAlleAb();
      return 'Passwort für "' + profile[i].name + '" geändert. Alle Anmeldungen wurden beendet.';
    }
  }
  throw new Error('Kein Profil mit diesem Namen.');
}

function setzeEmail(name, email) {
  nurImEditor_();
  var profile = lies_('profile');
  for (var i = 0; i < profile.length; i++) {
    if (String(profile[i].name).toLowerCase() === String(name).toLowerCase()) {
      profile[i].email = email || '';
      schreibe_('profile', profile[i]);
      return 'Erinnerungen für "' + profile[i].name + '" gehen an ' + (email || '(niemanden)') + '.';
    }
  }
  throw new Error('Kein Profil mit diesem Namen.');
}

/**
 * Loescht ein Profil samt allem, was daran haengt. Nicht rueckgaengig zu
 * machen – deshalb muss der Name genau stimmen.
 */
function loescheProfil(name) {
  nurImEditor_();
  var profile = lies_('profile');
  var treffer = null;
  for (var i = 0; i < profile.length; i++) {
    if (profile[i].name === name) { treffer = profile[i]; break; }
  }
  if (!treffer) throw new Error('Kein Profil mit genau diesem Namen.');

  var fahrzeuge = lies_('vehicles').filter(function (f) { return f.profilId === treffer.id; });
  fahrzeuge.forEach(function (f) {
    AM_FAHRZEUG.forEach(function (bestand) {
      lies_(bestand).forEach(function (z) {
        if (z.vehicleId === f.id) {
          if (bestand === 'docs' && z.driveId) loescheDatei_(z.driveId);
          entferne_(bestand, z.id);
        }
      });
    });
    entferne_('vehicles', f.id);
  });
  entferne_('profile', treffer.id);
  return 'Profil "' + name + '" und ' + fahrzeuge.length + ' Fahrzeug(e) gelöscht.';
}

/** Beendet alle laufenden Anmeldungen – etwa nach einem Passwortwechsel. */
/**
 * Beendet alle Anmeldungen - wirklich alle.
 *
 * Frueher loeschte das nur die Skripteigenschaften. profilAusToken_() sieht
 * aber ZUERST im Cache nach, und der haelt sechs Stunden: Nach einem
 * Passwortwechsel blieb jede laufende Sitzung gueltig, obwohl diese Funktion
 * das Gegenteil meldete. Jetzt werden die Schluessel eingesammelt und aus
 * beiden Ablagen entfernt.
 */
function meldeAlleAb() {
  nurImEditor_();
  var props = eigenschaften_();
  var alle = props.getProperties();
  var schluessel = [];
  Object.keys(alle).forEach(function (k) {
    if (k.indexOf('sitzung_') === 0) {
      schluessel.push(k);
      props.deleteProperty(k);
    }
  });
  if (schluessel.length) {
    try { CacheService.getScriptCache().removeAll(schluessel); } catch (e) {}
  }
  return 'Alle Anmeldungen beendet (' + schluessel.length + ').';
}

function setzeGeminiSchluessel(schluessel) {
  nurImEditor_();
  if (!schluessel) throw new Error('Kein Schluessel angegeben.');
  eigenschaften_().setProperty('GEMINI_KEY', String(schluessel).trim());
  return 'Gemini-Schlüssel hinterlegt. Er steht nur hier, nie im Browser.';
}

function setzeClaudeSchluessel(schluessel) {
  nurImEditor_();
  if (!schluessel) throw new Error('Kein Schluessel angegeben.');
  eigenschaften_().setProperty('CLAUDE_KEY', String(schluessel).trim());
  return 'Claude-Schlüssel hinterlegt. Er steht nur hier, nie im Browser.';
}

/**
 * Wer die Belege liest, wenn beide Schluessel hinterlegt sind.
 * 'auto' heisst: Gemini zuerst, Claude als Ausweg.
 */
function setzeErkennung(welche) {
  nurImEditor_();
  var w = String(welche || '').trim().toLowerCase();
  if (['claude', 'gemini', 'auto'].indexOf(w) < 0) {
    throw new Error('Erlaubt sind "claude", "gemini" oder "auto".');
  }
  var props = eigenschaften_();
  if (w === 'auto') props.deleteProperty('ERKENNUNG');
  else props.setProperty('ERKENNUNG', w);
  var stand = erkennungStand_();
  return stand.aktiv
    ? ('Belege liest jetzt: ' + stand.aktiv +
       (stand.zweit ? ' (Ausweg: ' + stand.zweit + ')' : ''))
    : 'Eingestellt – es fehlt aber noch der passende Schlüssel.';
}

/**
 * Darf der zweite Dienst einspringen, wenn der erste scheitert?
 *
 * Standard ist nein: Claude kostet je Beleg Geld, und ein Gemini-Ausfall
 * soll das nicht unbemerkt ausloesen. Der Beleg bleibt ohnehin gespeichert
 * und laesst sich spaeter erneut auslesen.
 *
 *     setzeErkennungAusweg(true)   // erlauben
 *     setzeErkennungAusweg(false)  // wieder abschalten
 */
function setzeErkennungAusweg(erlaubt) {
  nurImEditor_();
  var props = eigenschaften_();
  if (erlaubt === true) props.setProperty('ERKENNUNG_AUSWEG', 'ja');
  else props.deleteProperty('ERKENNUNG_AUSWEG');
  var stand = erkennungStand_();
  return stand.zweit
    ? 'Ausweg erlaubt: Scheitert ' + stand.aktiv + ', liest ' + stand.zweit + '.'
    : 'Kein Ausweg: Scheitert die Erkennung, bleibt der Beleg gespeichert und wird spaeter erneut ausgelesen.';
}

/** Ein anderes Claude-Modell, falls das voreingestellte nicht passt. */
function setzeClaudeModell(modell) {
  nurImEditor_();
  eigenschaften_().setProperty('CLAUDE_MODELL', String(modell || '').trim());
  return 'Claude-Modell: ' + (modell || 'Voreinstellung');
}

/**
 * Raeumt nach dem Ausprobieren auf: leert alle Datenblaetter und wirft die
 * Belege in den Papierkorb. Profile, Schluessel und die Tabelle selbst
 * bleiben – nur der Inhalt geht.
 *
 * Weil das nicht rueckgaengig zu machen ist, muss der Satz woertlich
 * mitgegeben werden:
 *
 *     leereTestdaten('JA ALLES LOESCHEN');
 *
 * Die Belege landen im Papierkorb von Drive, nicht im Nichts – 30 Tage lang
 * kommst du dort noch heran.
 */
function leereTestdaten(bestaetigung) {
  nurImEditor_();
  if (bestaetigung !== 'JA ALLES LOESCHEN') {
    throw new Error('Zum Bestaetigen: leereTestdaten("JA ALLES LOESCHEN")');
  }
  var gezaehlt = [];
  Object.keys(TABELLEN).forEach(function (name) {
    if (name === 'profile') return;
    var b = blatt_(name);
    var zeilen = b.getLastRow() - 1;
    if (zeilen > 0) b.deleteRows(2, zeilen);
    if (zeilen > 0) gezaehlt.push(name + ': ' + zeilen);
  });

  var belege = 0;
  var dateien = belegOrdner_().getFiles();
  while (dateien.hasNext()) { dateien.next().setTrashed(true); belege++; }
  var ordner = belegOrdner_().getFolders();
  while (ordner.hasNext()) {
    var f = ordner.next();
    var drin = f.getFiles();
    while (drin.hasNext()) { drin.next().setTrashed(true); belege++; }
    f.setTrashed(true);
  }
  // Die gemerkten Fahrzeugordner zeigen jetzt ins Leere.
  var props = eigenschaften_();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('ORDNER_F_') === 0) props.deleteProperty(k);
  });

  return [
    'Geleert: ' + (gezaehlt.length ? gezaehlt.join(', ') : 'nichts drin'),
    'Belege in den Papierkorb: ' + belege,
    'Profile und Schluessel sind geblieben.'
  ].join('\n');
}

/**
 * Prueft den hinterlegten Gemini-Schluessel, ohne einen Beleg zu brauchen.
 *
 * Fragt Google nach der Liste der Modelle. Kommt sie, stimmt der Schluessel
 * und das Modell ist erreichbar. Kommt ein Fehler, steht Googles eigene
 * Begruendung im Protokoll - das ist deutlich mehr als "antwortet nicht".
 */
function pruefeGemini() {
  nurImEditor_();
  var schluessel = eigenschaften_().getProperty('GEMINI_KEY');
  if (!schluessel) return console.log('Kein GEMINI_KEY hinterlegt.');

  console.log('Schluessel gefunden, ' + schluessel.length + ' Zeichen, beginnt mit "' +
              schluessel.slice(0, 4) + '".');
  // Bewusst kein Urteil ueber das Format: Google hat die Schluessel schon
  // mehrfach umgestellt, und ein Praefix sagt nichts darueber, ob der
  // Schluessel gilt. Das beantwortet nur Google selbst - gleich hier drunter.

  var antwort = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models',
    { headers: { 'x-goog-api-key': schluessel }, muteHttpExceptions: true });

  var code = antwort.getResponseCode();
  if (code !== 200) {
    var grund = '';
    try { grund = JSON.parse(antwort.getContentText()).error.message; } catch (e) {}
    console.log('Google lehnt ab (Fehler ' + code + ')' + (grund ? ': ' + grund : ''));
    console.log('400 = Gesuch falsch gestellt');
    console.log('403 = Schluessel falsch oder die API ist nicht freigeschaltet');
    console.log('404 = Modell unbekannt');
    console.log('429 = Kontingent erschoepft');
    return;
  }

  var alle = JSON.parse(antwort.getContentText()).models || [];
  // Nur Modelle, die Inhalte erzeugen koennen - Einbettungsmodelle nuetzen
  // fuer die Belegerkennung nichts.
  var taugliche = alle.filter(function (m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
  }).map(function (m) { return String(m.name).replace('models/', ''); });

  console.log('Schluessel gueltig. ' + alle.length + ' Modelle erreichbar, davon ' +
              taugliche.length + ' fuer die Belegerkennung geeignet.');

  var eingestellt = geminiModelle_();
  console.log('');
  console.log('Die App fragt der Reihe nach:');
  eingestellt.forEach(function (m) {
    console.log('  ' + m + ' -> ' + (taugliche.indexOf(m) >= 0 ? 'vorhanden' : 'GIBT ES NICHT'));
  });

  console.log('');
  console.log('Verfuegbar (Auswahl):');
  taugliche.filter(function (m) {
    return /flash|pro/.test(m) && !/embedding|tts|image|live|native/.test(m);
  }).slice(0, 20).forEach(function (m) { console.log('  ' + m); });

  console.log('');
  console.log('Passt etwas nicht: Skripteigenschaft GEMINI_MODELLE setzen, ' +
              'die gewuenschten durch Komma getrennt.');
}

/** Zeigt den Zustand der Einrichtung, ohne Geheimnisse preiszugeben. */
function zeigeEinrichtung() {
  nurImEditor_();
  var props = eigenschaften_();
  var profile = lies_('profile');
  var zeilen = [
    'Tabelle:        ' + (props.getProperty('TABELLE_ID') ? 'angelegt' : 'fehlt'),
    'Belegordner:    ' + (props.getProperty('ORDNER_ID') ? 'angelegt' : 'fehlt'),
    'Claude:         ' + (props.getProperty('CLAUDE_KEY') ? 'hinterlegt' : 'nicht hinterlegt'),
    'Gemini:         ' + (props.getProperty('GEMINI_KEY') ? 'hinterlegt' : 'nicht hinterlegt'),
    'Belege liest:   ' + (erkennungStand_().aktiv || 'niemand'),
    'Ausweg:         ' + (erkennungStand_().zweit || 'keiner (setzeErkennungAusweg)'),
    'Profile:        ' + profile.length
  ];
  profile.forEach(function (p) {
    zeilen.push('  - ' + p.name + ' (' + (p.rolle || 'nutzer') + ')' +
                (p.email ? ', Mail an ' + p.email : ', ohne Erinnerungen'));
  });
  var ausloeser = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'taeglichePruefung';
  });
  zeilen.push('Erinnerungen:   ' + (ausloeser.length ? 'täglich aktiv' : 'nicht eingerichtet'));

  // Der Skripteditor zeigt Rueckgabewerte nicht an - nur das, was
  // ausdruecklich ins Protokoll geschrieben wird. Ohne diese Zeile stand
  // nach dem Ausfuehren bloss "Ausfuehrung abgeschlossen", und der Bericht
  // blieb unsichtbar.
  var bericht = zeilen.join('\n');
  console.log(bericht);
  return bericht;
}
