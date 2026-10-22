package com.ifilmarabic

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.utils.*
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

@JsonIgnoreProperties(ignoreUnknown = true)
data class IFilmItem(
    @JsonProperty("Id") val id: Int = 0,
    @JsonProperty("CategoryId") val category: Int = 0,
    @JsonProperty("Title") val title: String? = null,
    @JsonProperty("ImageAddress_S") val image: String? = null,
    @JsonProperty("ImageAddress_M") val episodeImage: String? = null,
    @JsonProperty("VideoAddress") val video: String? = null,
    @JsonProperty("Episode") val episode: Int? = null,
)

class IFilmArabic : MainAPI() {
    override var mainUrl = "https://ar.ifilmtv.ir"
    override var name = "آي فيلم العربية"
    override var lang = "ar"
    override val hasMainPage = true
    override val supportedTypes = setOf(TvType.Movie, TvType.TvSeries)
    override val mainPage = mainPageOf("Series" to "المسلسلات", "Film" to "الأفلام")

    private fun Element.card(): SearchResponse? {
        val path = attr("href").substringBefore('?')
        if (!Regex("(?i)^/(series|film)/Content/\\d+").containsMatchIn(path)) return null
        val title = selectFirst("h6, h5, h4, h3")?.text()?.trim().orEmpty()
        if (title.isBlank()) return null
        val image = selectFirst("img")?.attr("src")?.takeIf { it.isNotBlank() }?.let { fixUrl(it) }
        return if (path.startsWith("/series", true)) {
            newTvSeriesSearchResponse(title, fixUrl(path), TvType.TvSeries) { posterUrl = image }
        } else {
            newMovieSearchResponse(title, fixUrl(path), TvType.Movie) { posterUrl = image }
        }
    }

    override suspend fun getMainPage(page: Int, request: MainPageRequest): HomePageResponse {
        val doc = app.get("$mainUrl/${request.data}?order=1&page=$page").document
        val cards = doc.select("a.inner-panel[href]").mapNotNull { it.card() }.distinctBy { it.url }
        val total = Regex("Counter2\\s*=\\s*parseInt\\((\\d+)\\)").find(doc.html())
            ?.groupValues?.get(1)?.toIntOrNull()
        return newHomePageResponse(request.name, cards, hasNext = total?.let { page * 18 < it } ?: (cards.size >= 18))
    }

    override suspend fun search(query: String): List<SearchResponse> {
        val items = app.get("$mainUrl/Home/Search", params = mapOf("searchstring" to query))
            .parsed<List<IFilmItem>>()
        return items.filter { it.category == 3 || it.category == 5 }.mapNotNull { item ->
            val title = item.title?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val image = item.image?.let { fixUrl(it) }
            if (item.category == 3) {
                newTvSeriesSearchResponse(title, "$mainUrl/Series/Content/${item.id}", TvType.TvSeries) { posterUrl = image }
            } else {
                newMovieSearchResponse(title, "$mainUrl/Film/Content/${item.id}", TvType.Movie) { posterUrl = image }
            }
        }.distinctBy { it.url }
    }

    private fun Document.meta(key: String) = selectFirst("meta[property='$key']")?.attr("content")?.takeIf { it.isNotBlank() }

    private suspend fun episodes(id: String, html: String): List<Episode> {
        // Match the site's own VOD branch; do not treat the series trailer as an episode.
        val external = Regex("var\\s+extrafild\\s*=\\s*\"([^\"]*)\"").find(html)?.groupValues?.get(1)
        if (!external.isNullOrBlank()) {
            val count = Regex("var\\s+inter_\\s*=\\s*(\\d+)").find(html)?.groupValues?.get(1)?.toIntOrNull() ?: 0
            require(count in 0..5000) { "Invalid episode count" }
            return (1..count).map { number ->
                newEpisode("https://vod.ifilmtv.ir/hls/ar$id/,$number,${number}_320,.mp4.urlset/master.m3u8") {
                    name = "الحلقة $number"
                    episode = number
                    posterUrl = "https://preview.presstv.co.uk/ifilm/ar$id/$number.png"
                }
            }
        }
        val result = mutableListOf<Episode>()
        val seen = mutableSetOf<String>()
        var page = 1
        while (page <= 200) {
            val batch = app.get("$mainUrl/Home/PageingAttachmentItem", params = mapOf(
                "id" to id, "page" to page.toString(), "size" to "50"
            )).parsed<List<IFilmItem>>()
            if (batch.isEmpty()) break
            var added = 0
            batch.forEach { item ->
                val path = item.video?.takeIf { it.isNotBlank() } ?: return@forEach
                val media = if (path.startsWith("http", true)) path else "https://video.ifilmtv.ir/ifilm/${path.trimStart('/')}"
                if (seen.add(media)) {
                    result.add(newEpisode(media) {
                        episode = item.episode
                        name = item.episode?.let { "الحلقة $it" } ?: item.title
                        posterUrl = item.episodeImage?.let { fixUrl(it) }
                    })
                    added++
                }
            }
            if (added == 0) break
            page++
        }
        return result.sortedBy { it.episode ?: Int.MAX_VALUE }
    }

    override suspend fun load(url: String): LoadResponse {
        val doc = app.get(url).document
        val title = doc.meta("og:title") ?: doc.selectFirst("h1")?.text() ?: throw ErrorLoadingException("العنوان غير متاح")
        val image = doc.meta("og:image")?.let { fixUrl(it) }
        val description = doc.meta("og:description")
        val releaseYear = Regex("[12][0-9]{3}").find(title)?.value?.toIntOrNull()
        if (url.contains("/Series/", true)) {
            val id = Regex("/Content/(\\d+)", RegexOption.IGNORE_CASE).find(url)?.groupValues?.get(1)
                ?: throw ErrorLoadingException("معرف المسلسل غير متاح")
            return newTvSeriesLoadResponse(title, url, TvType.TvSeries, episodes(id, doc.html())) {
                posterUrl = image
                plot = description
                year = releaseYear
            }
        }
        val source = doc.selectFirst("video source[src]")?.attr("src")?.takeIf { it.isNotBlank() }
            ?: throw ErrorLoadingException("لا يوجد فيديو متاح لهذا الفيلم على الموقع")
        return newMovieLoadResponse(title, url, TvType.Movie, fixUrl(source)) {
            posterUrl = image
            plot = description
            year = releaseYear
        }
    }

    override suspend fun loadLinks(data: String, isCasting: Boolean, subtitleCallback: (SubtitleFile) -> Unit, callback: (ExtractorLink) -> Unit): Boolean {
        val host = runCatching { java.net.URI(data).host?.lowercase() }.getOrNull() ?: return false
        if (!(host == "ifilmtv.ir" || host.endsWith(".ifilmtv.ir") || host == "preview.presstv.co.uk")) return false
        callback(newExtractorLink(name, name, data,
            if (data.contains(".m3u8", true)) ExtractorLinkType.M3U8 else ExtractorLinkType.VIDEO
        ) { referer = "$mainUrl/" })
        return true
    }
}
