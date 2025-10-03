/**
 * 🔄 RSS Sync Service pour La Revue App
 * Synchronise automatiquement les articles WordPress vers Firebase
 */

class RSSyncService {
    constructor() {
        this.sources = [
            {
                url: 'https://larevuedeshotels.com/feed',
                type: 'hotel',
                establishmentType: 'hotels'
            },
            {
                url: 'https://larevuedesrestaurants.com/feed',
                type: 'restaurant', 
                establishmentType: 'restaurants'
            }
        ];
        
        this.logs = [];
        this.isRunning = false;
    }

    log(message, type = 'info') {
        const logEntry = {
            timestamp: new Date().toLocaleString('fr-FR'),
            message: message,
            type: type
        };
        
        this.logs.unshift(logEntry);
        if (this.logs.length > 100) this.logs.pop(); // Garde seulement les 100 derniers logs
        
        console.log(`[${type.toUpperCase()}] ${message}`);
        
        // Mettre à jour l'affichage si possible
        this.updateUI();
    }

    updateUI() {
        try {
            // Mettre à jour le statut
            const statusDiv = document.getElementById('rssSyncStatus');
            if (statusDiv) {
                const isActive = this.isRunning;
                statusDiv.innerHTML = `
                    <div class="bg-${isActive ? 'blue' : 'green'}-50 border border-${isActive ? 'blue' : 'green'}-200 rounded-lg p-3">
                        <div class="text-sm text-${isActive ? 'blue' : 'green'}-800">
                            ${isActive ? '🔄 Synchronisation en cours...' : '✅ Synchronisation active'} - 
                            Dernière sync: <span id="lastSyncTime">${new Date().toLocaleString('fr-FR')}</span>
                        </div>
                        <div class="text-xs text-gray-600 mt-1">
                            ${this.logs.length} logs disponibles
                        </div>
                    </div>
                `;
            }
        } catch (error) {
            // Ignore les erreurs d'UI
        }
    }

    async syncAll() {
        if (this.isRunning) {
            this.log('❌ Synchronisation déjà en cours', 'warning');
            return;
        }

        this.isRunning = true;
        this.log('🚀 Début de la synchronisation RSS globale');
        
        let totalAdded = 0;
        let totalProcessed = 0;

        try {
            for (const source of this.sources) {
                this.log(`📡 Traitement de: ${source.url}`);
                const result = await this.syncSource(source);
                totalAdded += result.added;
                totalProcessed += result.processed;
            }

            this.log(`✅ Synchronisation terminée: ${totalAdded} nouveaux articles sur ${totalProcessed} traités`, 'success');
            
            // Recharger les actualités si la fonction existe
            if (typeof loadNews === 'function') {
                await loadNews();
            }
            
        } catch (error) {
            this.log(`❌ Erreur globale: ${error.message}`, 'error');
            throw error;
        } finally {
            this.isRunning = false;
            this.updateUI();
        }

        return { totalAdded, totalProcessed };
    }

    async syncSource(source) {
        let added = 0;
        let processed = 0;

        try {
            // 1. Récupérer le flux RSS via API
            const rssApiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(source.url)}&api_key=YOUR_API_KEY&count=20`;
            
            this.log(`📥 Récupération du flux: ${source.type}`);
            const response = await fetch(rssApiUrl);
            
            if (!response.ok) {
                throw new Error(`Erreur HTTP: ${response.status}`);
            }

            const rssData = await response.json();
            
            if (rssData.status !== 'ok') {
                throw new Error(`Erreur RSS: ${rssData.message}`);
            }

            this.log(`📊 ${rssData.items.length} articles trouvés pour ${source.type}`);

            // 2. Traiter chaque article
            for (const article of rssData.items) {
                try {
                    const wasAdded = await this.processArticle(article, source);
                    if (wasAdded) added++;
                    processed++;
                } catch (error) {
                    this.log(`❌ Erreur article "${article.title}": ${error.message}`, 'error');
                }
            }

            this.log(`✅ ${source.type}: ${added} nouveaux / ${processed} traités`);

        } catch (error) {
            this.log(`❌ Erreur source ${source.type}: ${error.message}`, 'error');
            throw error;
        }

        return { added, processed };
    }

    async processArticle(article, source) {
        try {
            // Vérifier si l'article existe déjà
            const existing = await db.collection('news')
                .where('url', '==', article.link)
                .limit(1)
                .get();

            if (!existing.empty) {
                // Article déjà existant
                return false;
            }

            // Nettoyer et préparer le contenu  
            const cleanContent = this.cleanContent(article.content || article.description);
            const summary = this.extractSummary(article.description || cleanContent);

            // Créer l'objet article
            const newsData = {
                title: article.title.trim(),
                content: cleanContent,
                summary: summary,
                url: article.link,
                type: source.type,
                establishmentType: source.establishmentType,
                status: 'published',
                featured: false,
                author: 'La Revue',
                source: source.url,
                publishedAt: new Date(article.pubDate),
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                views: 0,
                tags: ['actualité', source.type, 'wordpress'],
                syncedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            // Ajouter l'image si disponible
            if (article.thumbnail) {
                newsData.imageUrl = article.thumbnail;
            } else if (article.enclosure && article.enclosure.link) {
                newsData.imageUrl = article.enclosure.link;
            }

            // Extraire la ville depuis le contenu si possible
            const city = this.extractCity(cleanContent);
            if (city) {
                newsData.city = city;
            }

            // Sauvegarder dans Firebase
            await db.collection('news').add(newsData);
            
            this.log(`✅ Article ajouté: "${article.title.substring(0, 50)}..."`, 'success');
            return true;

        } catch (error) {
            this.log(`❌ Erreur traitement article: ${error.message}`, 'error');
            throw error;
        }
    }

    cleanContent(content) {
        if (!content) return 'Contenu à venir';
        
        // Supprimer les balises HTML indésirables mais garder la structure
        return content
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .trim();
    }

    extractSummary(content) {
        if (!content) return 'Résumé à venir';
        
        // Supprimer HTML et extraire les premiers 200 caractères
        const textContent = content.replace(/<[^>]*>/g, '').trim();
        
        if (textContent.length <= 200) return textContent;
        
        // Couper au dernier mot complet avant 200 caractères
        const truncated = textContent.substring(0, 200);
        const lastSpace = truncated.lastIndexOf(' ');
        
        return lastSpace > 150 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
    }

    extractCity(content) {
        if (!content) return null;
        
        // Villes françaises communes (pattern basique)
        const cities = [
            'Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Nantes', 'Strasbourg', 
            'Montpellier', 'Bordeaux', 'Lille', 'Rennes', 'Reims', 'Le Havre', 
            'Saint-Étienne', 'Toulon', 'Angers', 'Grenoble', 'Dijon', 'Nîmes', 'Aix-en-Provence'
        ];
        
        const textContent = content.replace(/<[^>]*>/g, '');
        
        for (const city of cities) {
            if (textContent.includes(city)) {
                return city;
            }
        }
        
        return null;
    }

    async testFeeds() {
        this.log('🧪 Test des flux RSS en cours...');
        
        const results = [];
        
        for (const source of this.sources) {
            try {
                const response = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(source.url)}&count=5`);
                const data = await response.json();
                
                const result = {
                    url: source.url,
                    type: source.type,
                    status: data.status,
                    itemCount: data.items ? data.items.length : 0,
                    error: data.message || null
                };
                
                results.push(result);
                
                if (data.status === 'ok') {
                    this.log(`✅ ${source.type}: ${data.items.length} articles disponibles`);
                } else {
                    this.log(`❌ ${source.type}: ${data.message}`, 'error');
                }
                
            } catch (error) {
                this.log(`❌ Erreur test ${source.type}: ${error.message}`, 'error');
                results.push({
                    url: source.url,
                    type: source.type,
                    status: 'error',
                    itemCount: 0,
                    error: error.message
                });
            }
        }
        
        this.log('🏁 Test des flux terminé');
        return results;
    }

    getLogs(limit = 50) {
        return this.logs.slice(0, limit);
    }

    clearLogs() {
        this.logs = [];
        this.log('🗑️ Logs supprimés');
    }
}

// Instance globale
window.rssService = new RSSyncService();

// Export pour utilisation
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RSSyncService;
}

console.log('✅ RSS Sync Service chargé et prêt !');
