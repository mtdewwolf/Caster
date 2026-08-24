package dev.caster.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Storage
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import dev.caster.android.ui.screens.DetailScreen
import dev.caster.android.ui.screens.HistoryScreen
import dev.caster.android.ui.screens.HomeScreen
import dev.caster.android.ui.screens.PlayerScreen
import dev.caster.android.ui.screens.SearchScreen
import dev.caster.android.ui.screens.SeriesScreen
import dev.caster.android.ui.screens.ServerScreen
import dev.caster.android.ui.screens.SetupScreen
import kotlinx.serialization.Serializable

@Serializable private object HomeRoute
@Serializable private object HistoryRoute
@Serializable private object ServerRoute
@Serializable private object SearchRoute
@Serializable private data class DetailRoute(val id: String)
@Serializable private data class SeriesRoute(val id: String)
@Serializable private data class PlayerRoute(val id: String)

private data class MainDestination(
    val route: Any,
    val label: String,
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
)

private val mainDestinations = listOf(
    MainDestination(HomeRoute, "Home", Icons.Rounded.Home),
    MainDestination(HistoryRoute, "History", Icons.Rounded.History),
    MainDestination(ServerRoute, "Server", Icons.Rounded.Storage),
)

@Composable
fun CasterApp(viewModel: CasterViewModel) {
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val setup by viewModel.setupState.collectAsStateWithLifecycle()
    when (val connected = connection) {
        AppConnectionState.Booting -> Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
            androidx.compose.material3.CircularProgressIndicator()
        }
        is AppConnectionState.NeedsSetup -> SetupScreen(setup, connected.initialSettings, viewModel::connect)
        is AppConnectionState.Connected -> ConnectedApp(viewModel, connected)
    }
}

@Composable
private fun ConnectedApp(viewModel: CasterViewModel, connection: AppConnectionState.Connected) {
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val routeName = backStack?.destination?.route.orEmpty()
    val isPlayer = routeName.contains("PlayerRoute")
    val isMain = mainDestinations.any { destination ->
        routeName.contains(destination.route::class.simpleName.orEmpty())
    }
    val density = LocalDensity.current
    val containerWidth = LocalWindowInfo.current.containerSize.width
    val wide = with(density) { containerWidth.toDp() >= 700.dp }
    val snackbar = remember { SnackbarHostState() }
    val message by viewModel.message.collectAsStateWithLifecycle()
    LaunchedEffect(message) {
        message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() }
    }

    if (wide && !isPlayer) {
        Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            if (isMain) MainRail(navController, routeName)
            Box(Modifier.weight(1f)) {
                CasterNavHost(navController, viewModel, connection)
                SnackbarHost(snackbar, Modifier.padding(12.dp))
            }
        }
    } else {
        Scaffold(
            contentWindowInsets = if (isPlayer) WindowInsets(0) else WindowInsets.safeDrawing,
            bottomBar = { if (isMain && !isPlayer) MainBar(navController, routeName) },
            snackbarHost = { SnackbarHost(snackbar) },
            containerColor = MaterialTheme.colorScheme.background,
        ) { padding ->
            CasterNavHost(navController, viewModel, connection, Modifier.padding(if (isPlayer) androidx.compose.foundation.layout.PaddingValues(0.dp) else padding))
        }
    }
}

@Composable
private fun CasterNavHost(
    navController: NavHostController,
    viewModel: CasterViewModel,
    connection: AppConnectionState.Connected,
    modifier: Modifier = Modifier,
) {
    val home by viewModel.home.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()
    val server by viewModel.server.collectAsStateWithLifecycle()
    val search by viewModel.search.collectAsStateWithLifecycle()
    val detail by viewModel.detail.collectAsStateWithLifecycle()
    val series by viewModel.series.collectAsStateWithLifecycle()
    val api = viewModel.currentApi() ?: return

    NavHost(navController, startDestination = HomeRoute, modifier = modifier) {
        composable<HomeRoute> {
            HomeScreen(home, api::thumbnailUrl, viewModel::loadHome, { navController.navigate(SearchRoute) },
                { navController.navigate(DetailRoute(it)) }, { navController.navigate(SeriesRoute(it)) })
        }
        composable<HistoryRoute> {
            HistoryScreen(history, api::thumbnailUrl, viewModel::loadHistory, { navController.navigate(DetailRoute(it)) })
        }
        composable<ServerRoute> {
            ServerScreen(server, connection.settings, connection.authenticated, viewModel::loadServer, viewModel::scanAll,
                viewModel::setHardwareAccel, viewModel::disconnect)
        }
        composable<SearchRoute> {
            SearchScreen(search, api::thumbnailUrl, { navController.popBackStack() }, viewModel::search,
                { navController.navigate(DetailRoute(it)) })
        }
        composable<DetailRoute> { entry ->
            val route = entry.toRoute<DetailRoute>()
            DetailScreen(route.id, detail, api::thumbnailUrl, viewModel::loadMedia, { navController.popBackStack() },
                { navController.navigate(PlayerRoute(it)) }, viewModel::markWatched, viewModel::markUnwatched)
        }
        composable<SeriesRoute> { entry ->
            val route = entry.toRoute<SeriesRoute>()
            SeriesScreen(route.id, series, api::thumbnailUrl, viewModel::loadSeries, { navController.popBackStack() },
                { navController.navigate(PlayerRoute(it)) })
        }
        composable<PlayerRoute> { entry ->
            val route = entry.toRoute<PlayerRoute>()
            PlayerScreen(route.id, detail, api, viewModel::loadMedia) { navController.popBackStack() }
        }
    }
}

@Composable
private fun MainBar(navController: NavHostController, currentRoute: String) {
    NavigationBar {
        mainDestinations.forEach { destination ->
            val selected = currentRoute.contains(destination.route::class.simpleName.orEmpty())
            NavigationBarItem(
                selected = selected,
                onClick = { navController.openMain(destination.route) },
                icon = { Icon(destination.icon, contentDescription = destination.label) },
                label = { Text(destination.label) },
            )
        }
    }
}

@Composable
private fun MainRail(navController: NavHostController, currentRoute: String) {
    NavigationRail {
        mainDestinations.forEach { destination ->
            val selected = currentRoute.contains(destination.route::class.simpleName.orEmpty())
            NavigationRailItem(
                selected = selected,
                onClick = { navController.openMain(destination.route) },
                icon = { Icon(destination.icon, contentDescription = destination.label) },
                label = { Text(destination.label) },
            )
        }
    }
}

private fun NavHostController.openMain(route: Any) {
    navigate(route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}
