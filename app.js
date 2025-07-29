// Configuration
const TEXT_COLUMNS = [
    'UID', 'Name', 'Rec', 'EU National', 'Position', 'Pros',
    'Preferred Foot', 'Inf', 'Transfer Value', 'Nat', 'Division', 'Club', 'Personality'
];

const PERCENTAGE_COLUMNS = ['Sv %', 'OP-Cr %', 'Hdr %', 'Conv %', 'Pas %', 'Cr C/A', 'Tck R', 'Pens Saved Ratio', 'Pen/R', 'Shot %'];

// League name fixes
const LEAGUE_NAME_FIXES = {
    'BrasileirÃ£o AssaÃ­ SÃ©rie A': 'Brasileirão Assaí Série A',
    'Primera FederaciÃ³n Grupo I': 'Primera Federación Grupo I',
    // ... (include all your league name fixes)
};

// League power defaults
let LEAGUE_POWER = {'Others': 5};

// Main data storage
let df = null;
let archetypeResults = {};

document.getElementById('analyze').addEventListener('click', async function() {
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    loading.style.display = 'block';
    results.style.display = 'none';
    
    try {
        // Load files
        const [signedFile, loansFile, universalFile, multipliersFile] = await Promise.all([
            getFile('signed'),
            getFile('loans'),
            getFile('universal'),
            getFile('multipliers')
        ]);
        
        // Process league multipliers
        if (multipliersFile) {
            LEAGUE_POWER = await loadLeaguePower(multipliersFile);
        }
        
        // Process HTML files
        const [df_signed, df_loans, df_universal] = await Promise.all([
            processHTML(signedFile, 'Available for Transfer'),
            processHTML(loansFile, 'Available on Loan'),
            processHTML(universalFile, 'Not Transferrable')
        ]);
        
        // Merge data
        df = mergeData(df_signed, df_loans, df_universal);
        
        // Clean and process data
        df = cleanAndConvertData(df);
        
        // Calculate archetype ratings
        archetypeResults = calculateArchetypes(df);
        
        // Display results
        displayResults(archetypeResults, df);
        
    } catch (error) {
        console.error('Error:', error);
        alert('Error processing files: ' + error.message);
    } finally {
        loading.style.display = 'none';
        results.style.display = 'block';
    }
});

// Helper function to read file
function getFile(id) {
    const fileInput = document.getElementById(id);
    if (fileInput.files.length > 0) {
        return fileInput.files[0];
    }
    return null;
}

// Load league power from Excel
async function loadLeaguePower(file) {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(worksheet);
    
    const powerMap = {'Others': 5};
    jsonData.forEach(row => {
        powerMap[row.League] = row['Power Rating'];
    });
    
    return powerMap;
}

// Process HTML file
async function processHTML(file, signability) {
    if (!file) return aq.table();
    
    const text = await file.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');
    const table = doc.querySelector('table');
    
    // Convert HTML table to Arquero table
    const data = Array.from(table.querySelectorAll('tr')).map(tr => {
        return Array.from(tr.querySelectorAll('th, td')).map(td => td.textContent.trim());
    });
    
    let df = aq.from(data.slice(1), data[0]);
    df = fixLeagueNames(df);
    return df.derive({Signability: aq.escape(() => signability);
    return normalizeUID(df);
}

// Fixed version - missing parenthesis added
function fixLeagueNames(df) {
    if (!df.columnNames().includes('Division')) return df;
    
    // Convert league fixes to params Arquero can use
    const leagueParams = Object.fromEntries(
        Object.entries(LEAGUE_NAME_FIXES).map(([key, val]) => 
            [`fix_${key}`, val]
        ) // <-- This parenthesis was missing
    );
    
    return df.params(leagueParams).derive({
        Division: aq.escape(d => {
            const original = d.Division;
            // Dynamically check all possible fixes
            for (const [key, val] of Object.entries(LEAGUE_NAME_FIXES)) {
                if (original === key) return val;
            }
            return original;
        })
    });
}

// Normalize UID
function normalizeUID(df) {
    if (!df.columnNames().includes('UID')) return df;
    
    return df.derive({
        UID: d => {
            const num = Number(d.UID);
            return isNaN(num) ? d.UID : num.toString();
        }
    });
}

// Merge data
function mergeData(df_signed, df_loans, df_universal) {
    let combined = aq.concat([df_signed, df_loans, df_universal]);
    
    // Remove duplicates by UID (keeping first occurrence)
    combined = combined.groupby('UID').slice(0, 1).ungroup();
    
    return combined;
}

function cleanAndConvertData(df) {
    // Convert minutes and filter
    if (df.columnNames().includes('Mins')) {
        df = df.filter(d => {
            const mins = Number(d.Mins);
            return !isNaN(mins) && mins >= 900;
        });
    }

    // Process percentage columns
    PERCENTAGE_COLUMNS.forEach(col => {
        if (df.columnNames().includes(col)) {
            df = df.derive({
                [col]: d => {
                    const val = String(d[col]).replace('%', '').replace('-', '');
                    const num = Number(val);
                    return isNaN(num) ? null : num;
                }
            });
        }
    });

    // Process Dist/90
    if (df.columnNames().includes('Dist/90')) {
        df = df.derive({
            'Dist/90': d => {
                const match = String(d['Dist/90']).match(/[\d.]+/);
                return match ? Number(match[0]) : null;
            }
        });
    }

    // Add league multiplier (only if Division exists)
    if (df.columnNames().includes('Division')) {
        df = df.derive({
            'League Multiplier': d => {
                const power = LEAGUE_POWER[d.Division] || LEAGUE_POWER['Others'];
                return power / 100.0;
            }
        });
    }

    // Convert other numeric columns
    df.columnNames().forEach(col => {
        if (!TEXT_COLUMNS.includes(col) && col !== 'Signability' && !PERCENTAGE_COLUMNS.includes(col)) {
            df = df.derive({
                [col]: d => {
                    const num = Number(d[col]);
                    return isNaN(num) ? null : num;
                }
            });
        }
    });

    return df;
}

// Calculate archetype ratings
function calculateArchetypes(df) {
    const results = {};
    
    // Define archetypes
    const ARCHETYPES = {
        "Sweeper Keeper": {
            filter: d => String(d.Position).includes("GK"),
            formula: d => (0.80 * d["xGP/90"] + 0.10 * (1 - d["Gl Mst/90"]) + 0.10 * d["Cln/90"]),
            label: "SK Rating"
        },
        // ... (include all your archetype definitions)
    };
    
    // Process each archetype
    Object.entries(ARCHETYPES).forEach(([role, config]) => {
        let roleDf = df.filter(config.filter);
        
        if (roleDf.numRows() > 0) {
            // Calculate ratings
            roleDf = roleDf.derive({
                [config.label]: config.formula,
                [`Adjusted ${config.label}`]: d => config.formula(d) * d['League Multiplier']
            });
            
            // Calculate percentiles
            const ratings = roleDf.array(`Adjusted ${config.label}`);
            const min = Math.min(...ratings);
            const max = Math.max(...ratings);
            
            roleDf = roleDf.derive({
                'Percentile': d => (d[`Adjusted ${config.label}`] - min) / (max - min)
            });
            
            // Store results
            results[role] = roleDf
                .select(['UID', 'Name', 'Position', 'Club', 'Division', 'Signability', 'Transfer Value', 
                        config.label, `Adjusted ${config.label}`, 'Percentile'])
                .orderby(`Adjusted ${config.label}`, aq.descending)
                .objects();
        }
    });
    
    return results;
}

// Display results
function displayResults(archetypeResults, fullData) {
    const tabsDiv = document.getElementById('tabs');
    const contentDiv = document.getElementById('content');
    
    tabsDiv.innerHTML = '';
    contentDiv.innerHTML = '';
    
    // Create tabs
    const tabButtons = [];
    Object.keys(archetypeResults).forEach((archetype, index) => {
        const button = document.createElement('button');
        button.textContent = archetype;
        button.addEventListener('click', () => showArchetype(archetype));
        tabsDiv.appendChild(button);
        tabButtons.push(button);
        
        if (index === 0) button.classList.add('active');
    });
    
    // Show first archetype by default
    if (tabButtons.length > 0) {
        showArchetype(Object.keys(archetypeResults)[0]);
    }
    
    function showArchetype(archetype) {
        // Update active tab
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabButtons.find(btn => btn.textContent === archetype).classList.add('active');
        
        // Show data
        const players = archetypeResults[archetype];
        if (!players || players.length === 0) {
            contentDiv.innerHTML = `<p>No players found for ${archetype}</p>`;
            return;
        }
        
        // Create table
        let html = `<h3>${archetype}</h3>`;
        html += `<table><tr>`;
        
        // Headers
        Object.keys(players[0]).forEach(key => {
            html += `<th>${key}</th>`;
        });
        html += `</tr>`;
        
        // Rows
        players.forEach(player => {
            html += `<tr>`;
            Object.values(player).forEach(value => {
                if (typeof value === 'number') {
                    if (value <= 1) { // Assume it's a percentage
                        html += `<td>${(value * 100).toFixed(1)}%</td>`;
                    } else {
                        html += `<td>${value.toFixed(2)}</td>`;
                    }
                } else {
                    html += `<td>${value || ''}</td>`;
                }
            });
            html += `</tr>`;
        });
        
        html += `</table>`;
        contentDiv.innerHTML = html;
    }
}
