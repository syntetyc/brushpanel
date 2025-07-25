let pyodideReadyPromise = null;
async function loadPyodideAndPackages() {
  if (!pyodideReadyPromise) {
    pyodideReadyPromise = loadPyodide({indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/"});
  }
  return pyodideReadyPromise;
}

const fileInput = document.getElementById('fileInput');
const uploadDiv = document.querySelector('.upload');
const setsDiv = document.getElementById('sets');
const errorDiv = document.getElementById('error');
const progressBarContainer = document.getElementById('progressBarContainer');
const progressBar = document.getElementById('progressBar');
let sets = [];
let viewMode = 'grid'; // 'grid' o 'list'
const toggleViewBtn = document.getElementById('toggleViewBtn');
const toggleViewIcon = document.getElementById('toggleViewIcon');
toggleViewBtn.onclick = function() {
  // Solo fade en los previews de sets expandidos
  document.querySelectorAll('.thumbnails, .thumbnails-list').forEach(el => {
    el.classList.remove('previews-fade-in');
    el.classList.add('previews-fade-switch');
  });
  setTimeout(() => {
    viewMode = viewMode === 'grid' ? 'list' : 'grid';
    toggleViewIcon.textContent = viewMode === 'grid' ? 'list' : 'grid_view';
    renderSets();
    document.querySelectorAll('.thumbnails, .thumbnails-list').forEach(el => {
      el.classList.remove('previews-fade-switch');
      el.classList.add('previews-fade-in');
    });
  }, 180);
};
toggleViewIcon.textContent = 'list';

const toggleExpandBtn = document.getElementById('toggleExpandBtn');
const toggleExpandIcon = document.getElementById('toggleExpandIcon');
toggleExpandBtn.onclick = function() {
  const allExpanded = sets.length > 0 && sets.every(s => s.expanded);
  sets.forEach(s => s.expanded = !allExpanded);
  toggleExpandIcon.textContent = allExpanded ? 'unfold_more' : 'unfold_less';
  renderSets();
};
function updateExpandIcon() {
  const allExpanded = sets.length > 0 && sets.every(s => s.expanded);
  toggleExpandIcon.textContent = allExpanded ? 'unfold_less' : 'unfold_more';
}

async function extractBrushNamesPyodide(file) {
  const pyodide = await loadPyodideAndPackages();
  const arrayBuffer = await file.arrayBuffer();
  pyodide.FS.writeFile('temp.brushset', new Uint8Array(arrayBuffer));
  const pyCode = `
import zipfile
import plistlib

CLASSES_TO_IGNORE = {
    'NSArray', 'NSDictionary', 'NSString', 'NSData', 'NSDate', 'NSNull',
    'NSMutableArray', 'NSMutableDictionary', 'NSMutableString', 'NSNumber',
    'NSObject', 'NSKeyedArchiver', 'NSKeyedUnarchiver',
    'ValkyrieBrushRollParameters',
    '$null', 'SYNTETYC', 'SilicaBrush', 'ValkyrieBrush', 'alCurve', 'ValkyrieMagnitudin', 'ValkyrieMagnitudinalCurve'
}

def is_excluded(s):
    if s in CLASSES_TO_IGNORE:
        return True
    if s.endswith('.png'):
        return True
    if s == 'Brush-Preset':
        return True
    return False

def collect_strings(obj, found=None):
    if found is None:
        found = []
    if isinstance(obj, dict):
        for v in obj.values():
            collect_strings(v, found)
    elif isinstance(obj, list):
        for item in obj:
            collect_strings(item, found)
    elif isinstance(obj, str):
        if (
            len(obj) > 2
            and any(c.isalpha() for c in obj)
            and not is_excluded(obj)
        ):
            found.append(obj)
    return found

names = []
with zipfile.ZipFile('temp.brushset', 'r') as z:
    for file in z.namelist():
        if file.endswith('Brush.archive'):
            with z.open(file) as f:
                try:
                    data = f.read()
                    plist = plistlib.loads(data)
                    objects = plist.get('$objects')
                    found = []
                    if objects:
                        for obj in objects:
                            collect_strings(obj, found)
                    if found:
                        name = found[0]
                    else:
                        name = 'Nombre desconocido'
                    names.append((file, name))
                except Exception:
                    names.append((file, '[Error leyendo metadata]'))
names
`;
  const result = await pyodide.runPythonAsync(pyCode);
  return result.toJs();
}

async function handleBrushsetFiles(fileList) {
  const uploadDiv = document.querySelector('.upload');
  const dropRow = document.querySelector('.drop-row');
  if (uploadDiv) uploadDiv.classList.add('loading');
  if (dropRow) {
    dropRow.classList.remove('fade-in');
    dropRow.classList.add('fade-out');
  }
  errorDiv.textContent = '';
  // Filtrar solo archivos .brushset
  const files = Array.from(fileList).filter(f => f.name && f.name.endsWith('.brushset'));
  if (!files.length) {
    errorDiv.textContent = 'Selecciona uno o más archivos .brushset';
    if (uploadDiv) uploadDiv.classList.remove('loading');
    if (dropRow) {
      dropRow.classList.remove('fade-out');
      dropRow.classList.add('fade-in');
    }
    return;
  }
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      errorDiv.textContent = '';
      progressBarContainer.style.display = 'block';
      progressBar.style.width = '0%';
      const brushNamesList = await extractBrushNamesPyodide(file);
      let brushNamesArr = Array.isArray(brushNamesList)
        ? brushNamesList
        : (brushNamesList.toJs ? brushNamesList.toJs() : []);
      const nameMap = {};
      for (const [path, name] of brushNamesArr) {
        let folder = path.replace(/Brush.archive$/, '').replace(/^\/?|\/?$/g, '').toLowerCase();
        nameMap[folder] = name;
      }
      const zip = await JSZip.loadAsync(file);
      const thumbnails = [];
      const thumbFiles = Object.keys(zip.files).filter(filename => filename.endsWith('QuickLook/Thumbnail.png'));
      // Buscar AuthorPicture (puede estar en la raíz o en subcarpetas)
      let authorAvatar = null;
      const authorPicFile = Object.keys(zip.files).find(filename => /AuthorPicture\//i.test(filename) && filename.match(/\.(png|jpg|jpeg)$/i));
      if (authorPicFile) {
        const authorData = await zip.files[authorPicFile].async('base64');
        authorAvatar = 'data:image/png;base64,' + authorData;
      }
      const totalThumbs = thumbFiles.length;
      let thumbsDone = 0;
      await Promise.all(thumbFiles.map(async (thumbPath) => {
        const fileData = await zip.files[thumbPath].async('base64');
        let folderPath = thumbPath.replace(/QuickLook\/Thumbnail.png$/, '').replace(/^\/?|\/?$/g, '').toLowerCase();
        const brushName = nameMap[folderPath] || '(Sin nombre)';
        thumbnails.push({ src: 'data:image/png;base64,' + fileData, name: brushName });
        thumbsDone++;
        progressBar.style.width = Math.round((thumbsDone / totalThumbs) * 100) + '%';
      }));
      // Filtrar duplicados por nombre
      const uniqueThumbnails = [];
      const seenNames = new Set();
      for (const thumb of thumbnails) {
        if (!seenNames.has(thumb.name)) {
          uniqueThumbnails.push(thumb);
          seenNames.add(thumb.name);
        }
      }
      if (uniqueThumbnails.length === 0) {
        progressBarContainer.style.display = 'none';
        errorDiv.textContent = 'No se encontraron miniaturas en el set.';
        continue;
      }
      // Eliminar lógica de autor
      const newSet = { name: file.name, thumbnails: uniqueThumbnails, expanded: true, authorAvatar };
      // Añadir el nuevo set al principio del array para que aparezca arriba
      sets.unshift(newSet);
      renderSetsWithFade(0, true);
      fileInput.value = '';
      errorDiv.textContent = '';
      progressBar.style.width = '100%';
      await new Promise(res => setTimeout(res, 400));
      progressBarContainer.style.display = 'none';
    } catch (e) {
      progressBarContainer.style.display = 'none';
      errorDiv.textContent = 'Error al leer el archivo: ' + e.message;
      console.error(e);
    }
  }
  if (uploadDiv) uploadDiv.classList.remove('loading');
  if (dropRow) {
    dropRow.classList.remove('fade-out');
    dropRow.classList.add('fade-in');
  }
}

// Drag & Drop y click en el área
uploadDiv.addEventListener('click', () => {
  fileInput.click();
});
uploadDiv.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadDiv.classList.add('dragover');
});
uploadDiv.addEventListener('dragleave', (e) => {
  e.preventDefault();
  uploadDiv.classList.remove('dragover');
});
uploadDiv.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadDiv.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    handleBrushsetFiles(e.dataTransfer.files);
  }
});
fileInput.addEventListener('change', (e) => {
  if (fileInput.files && fileInput.files.length > 0) {
    handleBrushsetFiles(fileInput.files);
  }
});
document.getElementById('dropClickBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

// Estado para navegación en el modal
let previewState = { setIdx: 0, thumbIdx: 0 };

// Palabras clave para filtrar pinceles
const FILTER_KEYWORDS = [
  'Sketch', 'Texture', 'Cloud', 'Soft', 'Leaf', 'Grass', 'Tree', 'Foliage', 'Water', 'Watercolor',
  'Splatter', 'Smudge', 'Hard', 'Airsoft', 'Line',
  'Gouache', 'Oil', 'Pastel', 'Pencil', 'Pen', 'Ballpen', 'Marker'
];
let filterPanelOpen = false;
let activeFilters = [];
let filteredSets = null; // null = sin filtro, array = sets filtrados
const filterPanelContainer = document.getElementById('filterPanelContainer');
const filterBtn = document.getElementById('filterBtn');
const filterBtnIcon = document.getElementById('filterBtnIcon');
const appliedFiltersInfo = document.getElementById('appliedFiltersInfo');
function renderAppliedFiltersInfo() {
  if (activeFilters.length === 0) {
    appliedFiltersInfo.innerHTML = '';
    return;
  }
  appliedFiltersInfo.innerHTML = `Applied filters: <span class="applied-filters-list">${activeFilters.join(', ')}</span> <span class="applied-filters-clear">clear all</span>`;
  appliedFiltersInfo.querySelector('.applied-filters-clear').onclick = () => {
    activeFilters = [];
    filteredSets = null;
    renderFilterPanel();
    renderAppliedFiltersInfo();
    renderSets();
  };
}

filterBtn.onclick = function() {
  filterPanelOpen = !filterPanelOpen;
  filterBtnIcon.textContent = filterPanelOpen ? 'close' : 'filter_alt';
  filterBtn.classList.toggle('active', filterPanelOpen);
  renderFilterPanel();
  renderAppliedFiltersInfo();
};

function renderFilterPanel() {
  if (!filterPanelOpen) {
    filterPanelContainer.innerHTML = '';
    renderAppliedFiltersInfo();
    return;
  }
  // Detectar palabras clave presentes en los nombres de todos los pinceles
  const allNames = sets.flatMap(set => set.thumbnails.map(t => t.name));
  const presentKeywords = FILTER_KEYWORDS.filter(word =>
    allNames.some(name => name.toLowerCase().includes(word.toLowerCase()))
  );
  if (presentKeywords.length === 0) {
    filterPanelContainer.innerHTML = '<div class="filter-panel">No filters available for current brush names.</div>';
    return;
  }
  // Render chips
  filterPanelContainer.innerHTML = `
    <div class="filter-panel">
      <div class="filter-chips">
        ${presentKeywords.map(word => {
          const active = activeFilters.includes(word);
          const icon = active ? 'check_box' : 'check_box_outline_blank';
          return `<span class="filter-chip${active ? ' active' : ''}" data-word="${word}">
            <span class="material-symbols-rounded">${icon}</span>${word}
          </span>`;
        }).join('')}
      </div>
      <div class="filter-panel-actions">
        <button class="filter-clear-btn">Clear filters</button>
      </div>
    </div>
  `;
  // Eventos chips
  filterPanelContainer.querySelectorAll('.filter-chip').forEach(chip => {
    chip.onclick = () => {
      const word = chip.getAttribute('data-word');
      if (activeFilters.includes(word)) {
        activeFilters = activeFilters.filter(f => f !== word);
      } else {
        activeFilters.push(word);
      }
      // Filtrado en tiempo real
      if (activeFilters.length === 0) {
        filteredSets = null;
      } else {
        filteredSets = sets.map(set => ({
          ...set,
          thumbnails: set.thumbnails.filter(thumb =>
            activeFilters.some(word => thumb.name.toLowerCase().includes(word.toLowerCase()))
          )
        }));
      }
      renderFilterPanel();
      renderAppliedFiltersInfo();
      renderSets();
    };
  });
  // Evento Clear
  filterPanelContainer.querySelector('.filter-clear-btn').onclick = () => {
    activeFilters = [];
    filteredSets = null;
    renderFilterPanel();
    renderAppliedFiltersInfo();
    renderSets();
  };
}

function renderSets() {
  renderAppliedFiltersInfo();
  setsDiv.innerHTML = '';
  const setsTitleBar = document.getElementById('setsTitleBar');
  const setsTitleText = document.getElementById('setsTitleText');
  const clearAllBtn = document.getElementById('clearAllBtn');
  if (sets.length === 0) {
    setsTitleBar.style.display = 'none';
    setsDiv.innerHTML = '';
    return;
  } else {
    const totalBrushes = sets.reduce((acc, set) => acc + set.thumbnails.length, 0);
    setsTitleText.innerHTML = `${sets.length} Set${sets.length === 1 ? '' : 's'} added` +
      `<br><span style="color:#a1a1aa;font-size:0.85em;font-weight:400;">${totalBrushes} Brushes in total</span>`;
    setsTitleBar.style.display = 'flex';
    clearAllBtn.onclick = () => {
      sets.length = 0;
      filterPanelOpen = false;
      activeFilters = [];
      filteredSets = null;
      renderFilterPanel();
      renderAppliedFiltersInfo();
      renderSets();
    };
  }
  updateExpandIcon();
  setTimeout(() => setsDiv.classList.add('sets-fade-in'), 10);
  const setsToRender = filteredSets !== null ? filteredSets : sets;
  setsToRender.forEach((set, idx) => {
    const setDiv = document.createElement('div');
    setDiv.className = 'set';
    const header = document.createElement('div');
    header.className = 'set-header';
    header.innerHTML = `
      <span style="flex:1;display:flex;align-items:center;gap:0.7rem;text-align:left;">
        <span class="set-avatar">${set.authorAvatar ?
          `<img src=\"${set.authorAvatar}\" alt=\"Autor\">` :
          `<span class=\"material-symbols-rounded\" style=\"font-size:1.5em;color:#0078E0;\">brush</span>`}
        </span>
        ${set.name}
        <span style=\"color:#a1a1aa;font-size:1.02em;font-weight:400;margin-left:0.5em;\">(${set.thumbnails.length} brushes)</span>
      </span>
      <span style="display:flex;align-items:center;gap:0.5rem;">
        <button type="button" class="icon-btn delete-set" title="Borrar set" data-set-idx="${idx}"><span class="material-symbols-rounded">delete</span></button>
        <button type="button" class="icon-btn toggle-set" title="Desplegar/cerrar"><span class="material-symbols-rounded">${set.expanded ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}</span></button>
      </span>
    `;
    if (!set.expanded) {
      header.classList.add('collapsed');
    } else {
      header.classList.remove('collapsed');
    }
    header.querySelector('.delete-set').onclick = (e) => {
      e.stopPropagation();
      // FLIP animation for smooth repositioning
      const allSetDivs = Array.from(document.querySelectorAll('.set'));
      const firstRects = allSetDivs.map(div => div.getBoundingClientRect());
      const setDivToRemove = setDiv;
      setDivToRemove.classList.add('set-fade-out');
      setTimeout(() => {
        sets.splice(idx, 1);
        renderSets();
        // After render, animate the rest
        requestAnimationFrame(() => {
          const newSetDivs = Array.from(document.querySelectorAll('.set'));
          newSetDivs.forEach((div, i) => {
            const lastRect = div.getBoundingClientRect();
            const firstRect = firstRects[i >= idx ? i + 1 : i];
            if (firstRect) {
              const dy = firstRect.top - lastRect.top;
              if (dy) {
                div.style.transform = `translateY(${dy}px)`;
                div.style.transition = 'none';
                requestAnimationFrame(() => {
                  div.style.transition = 'transform 0.45s cubic-bezier(.4,1.3,.6,1)';
                  div.style.transform = '';
                });
              }
            }
          });
        });
      }, 380);
    };
    header.onclick = (e) => {
      if (e.target.closest('.delete-set')) return;
      if (e.target.closest('.toggle-set')) {
        set.expanded = !set.expanded;
        renderSetsWithFade(idx, set.expanded);
        return;
      }
      set.expanded = !set.expanded;
      renderSetsWithFade(idx, set.expanded);
    };
    setDiv.appendChild(header);
    if (set.expanded) {
      if (viewMode === 'grid') {
        const thumbsDiv = document.createElement('div');
        thumbsDiv.className = 'thumbnails previews-fade-in';
        set.thumbnails.forEach((thumb, tIdx) => {
          const thumbBox = document.createElement('div');
          if (set._justOpened) {
            thumbBox.className = 'thumbnail-box fade-in';
          } else {
            thumbBox.className = 'thumbnail-box';
          }
          const nameDiv = document.createElement('div');
          nameDiv.className = 'thumbnail-name';
          nameDiv.textContent = thumb.name;
          thumbBox.appendChild(nameDiv);
          const img = document.createElement('img');
          img.src = thumb.src;
          img.loading = 'lazy';
          img.style.cursor = 'zoom-in';
          thumbBox.appendChild(img);
          // Hacer toda la caja clicable
          thumbBox.style.cursor = 'zoom-in';
          thumbBox.onclick = () => showPreviewFiltered(set, tIdx);
          thumbsDiv.appendChild(thumbBox);
        });
        setDiv.appendChild(thumbsDiv);
      } else {
        // Modo listado
        const listDiv = document.createElement('div');
        listDiv.className = 'thumbnails-list previews-fade-in';
        set.thumbnails.forEach((thumb, tIdx) => {
          const row = document.createElement('div');
          row.className = 'thumbnail-list-row';
          const nameDiv = document.createElement('div');
          nameDiv.className = 'thumbnail-list-name';
          nameDiv.textContent = thumb.name;
          row.appendChild(nameDiv);
          const img = document.createElement('img');
          img.className = 'thumbnail-list-img';
          img.src = thumb.src;
          img.loading = 'lazy';
          img.style.cursor = 'zoom-in';
          row.appendChild(img);
          row.onclick = () => showPreviewFiltered(set, tIdx);
          listDiv.appendChild(row);
        });
        setDiv.appendChild(listDiv);
      }
    }
    setsDiv.appendChild(setDiv);
    // En renderSets, añade evento para ampliar el avatar si existe
    setTimeout(() => {
      const avatarImg = header.querySelector('.set-avatar img');
      if (avatarImg) {
        avatarImg.style.cursor = 'zoom-in';
        avatarImg.onclick = (e) => {
          e.stopPropagation();
          showAvatarModal(set.authorAvatar);
        };
      }
    }, 0);
  });
}

// Controlar el fade solo en el set abierto/cerrado
let lastToggledSet = null;
function renderSetsWithFade(toggledIdx = null, opening = false) {
  // Solo animar sets nuevos, no al expandir/plegando
  const setsDivs = document.querySelectorAll('.set');
  setsDivs.forEach(div => div.classList.remove('fade-in-set'));
  // Si se está añadiendo un set nuevo (no expandiendo/plegando)
  if (toggledIdx !== null && opening) {
    // No animar
    renderSets();
    return;
  }
  renderSets();
  // Después de renderizar, añadir animación solo al último set (el nuevo)
  const newSets = document.querySelectorAll('.set');
  if (newSets.length > 0) {
    newSets[newSets.length - 1].classList.add('fade-in-set');
  }
}

function showPreview(setIdx, thumbIdx, direction = null) {
  previewState.setIdx = setIdx;
  previewState.thumbIdx = thumbIdx;
  const set = sets[setIdx];
  const thumb = set.thumbnails[thumbIdx];
  const modal = document.getElementById('previewModal');
  const img = document.getElementById('previewImg');
  const nameDiv = document.getElementById('previewName');
  const setTitle = document.getElementById('previewSetTitle');
  // Contador de pinceles
  const counterDiv = document.getElementById('previewCounter');
  counterDiv.textContent = `${thumbIdx + 1} of ${set.thumbnails.length}`;
  // Animación slide
  img.classList.remove('preview-slide', 'preview-slide-left', 'preview-slide-right');
  void img.offsetWidth; // reflow
  if (direction === 'left') {
    img.classList.add('preview-slide-left');
  } else if (direction === 'right') {
    img.classList.add('preview-slide-right');
  } else {
    img.classList.add('preview-slide');
  }
  img.src = thumb.src;
  // Animación nombre pincel
  nameDiv.classList.remove('preview-name-fade-in', 'preview-name-fade-out');
  void nameDiv.offsetWidth;
  nameDiv.classList.add('preview-name-fade-out');
  setTimeout(() => {
    nameDiv.textContent = thumb.name;
    nameDiv.classList.remove('preview-name-fade-out');
    nameDiv.classList.add('preview-name-fade-in');
  }, 180);
  setTitle.textContent = set.name;
  modal.style.display = 'flex';
  modal.classList.remove('modal-fade-out');
  void modal.offsetWidth;
  modal.classList.add('modal-fade-in');
  const prevBtn = document.getElementById('previewPrev');
  const nextBtn = document.getElementById('previewNext');
  prevBtn.style.display = (thumbIdx === 0) ? 'none' : '';
  nextBtn.style.display = (thumbIdx === set.thumbnails.length - 1) ? 'none' : '';
  // Si hay filtro global activo, delegar en showPreviewFiltered con el set filtrado correspondiente
  if (filteredSets !== null) {
    const set = filteredSets.find(s => s.name === setsToRender[setIdx].name);
    if (set) {
      showPreviewFiltered(set, thumbIdx, direction);
      return;
    }
  }
}
document.getElementById('closePreview').onclick = function() {
  const modal = document.getElementById('previewModal');
  modal.classList.remove('modal-fade-in');
  modal.classList.add('modal-fade-out');
  setTimeout(() => {
    modal.style.display = 'none';
  }, 320);
};
document.getElementById('previewModal').onclick = function(e) {
  if (e.target === this) {
    this.classList.remove('modal-fade-in');
    this.classList.add('modal-fade-out');
    setTimeout(() => {
      this.style.display = 'none';
    }, 320);
  }
};
document.getElementById('previewPrev').onclick = function(e) {
  e.stopPropagation();
  if (previewState.thumbIdx > 0) {
    showPreview(previewState.setIdx, previewState.thumbIdx - 1, 'right');
  }
};
document.getElementById('previewNext').onclick = function(e) {
  e.stopPropagation();
  const set = sets[previewState.setIdx];
  if (previewState.thumbIdx < set.thumbnails.length - 1) {
    showPreview(previewState.setIdx, previewState.thumbIdx + 1, 'left');
  }
};

// Exportar a TXT la lista de nombres de todos los sets cargados
document.getElementById('exportTxtBtn').onclick = function() {
  const setsToExport = filteredSets !== null ? filteredSets : sets;
  if (!setsToExport.length) return;
  let txt = 'Exported from brushpanel.com\n\n';
  setsToExport.forEach(set => {
    txt += set.name + '\n';
    set.thumbnails.forEach(thumb => {
      txt += '  - ' + thumb.name + '\n';
    });
    txt += '\n';
  });
  const blob = new Blob([txt], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'brushpanel.txt';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
};

function updateUploadAreaHeight() {
  const uploadDiv = document.querySelector('.upload');
  if (!uploadDiv) return;
  if (sets.length > 0) {
    uploadDiv.classList.add('has-files');
  } else {
    uploadDiv.classList.remove('has-files');
  }
}
// Llama a updateUploadAreaHeight después de renderSets, renderSetsWithFade y al cargar/quitar archivos
const _originalRenderSets = renderSets;
renderSets = function() {
  _originalRenderSets.apply(this, arguments);
  updateUploadAreaHeight();
};
const _originalRenderSetsWithFade = renderSetsWithFade;
renderSetsWithFade = function() {
  _originalRenderSetsWithFade.apply(this, arguments);
  updateUploadAreaHeight();
};
// Llama también al inicio para el estado inicial
updateUploadAreaHeight();

renderSets();

// Overlay para pinceles filtrados
function showPreviewFiltered(set, thumbIdx, direction = null) {
  // set es el set filtrado (puede tener menos thumbnails)
  previewState.setIdx = set.name; // Usamos el nombre como identificador
  previewState.thumbIdx = thumbIdx;
  previewState._filteredThumbs = set.thumbnails;
  const thumb = set.thumbnails[thumbIdx];
  const modal = document.getElementById('previewModal');
  const img = document.getElementById('previewImg');
  const nameDiv = document.getElementById('previewName');
  const setTitle = document.getElementById('previewSetTitle');
  const counterDiv = document.getElementById('previewCounter');
  counterDiv.textContent = `${thumbIdx + 1} of ${set.thumbnails.length}`;
  // Forzar actualización de la imagen antes de la animación
  img.src = '';
  void img.offsetWidth;
  // Animación slide
  img.classList.remove('preview-slide', 'preview-slide-left', 'preview-slide-right');
  void img.offsetWidth;
  if (direction === 'left') {
    img.classList.add('preview-slide-left');
  } else if (direction === 'right') {
    img.classList.add('preview-slide-right');
  } else {
    img.classList.add('preview-slide');
  }
  img.src = thumb.src;
  // Animación nombre pincel
  nameDiv.classList.remove('preview-name-fade-in', 'preview-name-fade-out');
  void nameDiv.offsetWidth;
  nameDiv.classList.add('preview-name-fade-out');
  setTimeout(() => {
    nameDiv.textContent = thumb.name;
    nameDiv.classList.remove('preview-name-fade-out');
    nameDiv.classList.add('preview-name-fade-in');
  }, 180);
  setTitle.textContent = set.name;
  modal.style.display = 'flex';
  modal.classList.remove('modal-fade-out');
  void modal.offsetWidth;
  modal.classList.add('modal-fade-in');
  const prevBtn = document.getElementById('previewPrev');
  const nextBtn = document.getElementById('previewNext');
  prevBtn.style.display = (thumbIdx === 0) ? 'none' : '';
  nextBtn.style.display = (thumbIdx === set.thumbnails.length - 1) ? 'none' : '';
  // Navegación
  prevBtn.onclick = function(e) {
    e.stopPropagation();
    if (thumbIdx > 0) {
      showPreviewFiltered(set, thumbIdx - 1, 'right');
    }
  };
  nextBtn.onclick = function(e) {
    e.stopPropagation();
    if (thumbIdx < set.thumbnails.length - 1) {
      showPreviewFiltered(set, thumbIdx + 1, 'left');
    }
  };
}

// Añade función para mostrar el modal de avatar ampliado
function showAvatarModal(src) {
  let modal = document.getElementById('avatarModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'avatarModal';
    modal.style.position = 'fixed';
    modal.style.zIndex = '2000';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.background = 'rgba(0,0,0,0.85)';
    modal.style.backdropFilter = 'blur(8px)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.cursor = 'zoom-out';
    modal.onclick = () => { modal.style.display = 'none'; };
    const img = document.createElement('img');
    img.id = 'avatarModalImg';
    img.style.maxWidth = '40vw';
    img.style.maxHeight = '70vh';
    // Quitar border-radius para mostrar la imagen original
    img.style.borderRadius = '8px';
    img.style.boxShadow = '0 4px 32px 0 #000a';
    img.style.background = '#222';
    img.style.border = '4px solid #fff2';
    modal.appendChild(img);
    document.body.appendChild(modal);
  }
  const img = document.getElementById('avatarModalImg');
  img.src = src;
  modal.style.display = 'flex';
}

// ===================
// Menú lateral de opciones (settings)
// ===================
const settingsBtn = document.getElementById('settingsBtn');
const sideMenu = document.getElementById('sideMenu');

settingsBtn.onclick = (e) => {
  e.stopPropagation();
  sideMenu.classList.toggle('open');
};

document.addEventListener('click', (e) => {
  if (
    sideMenu.classList.contains('open') &&
    !sideMenu.contains(e.target) &&
    e.target !== settingsBtn
  ) {
    sideMenu.classList.remove('open');
  }
});
// =================== 